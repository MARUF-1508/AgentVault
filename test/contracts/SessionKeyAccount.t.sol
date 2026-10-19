// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionKeyAccount, PackedUserOperation} from "../../contracts/SessionKeyAccount.sol";

/// @notice A contract the session may call: `ping` is granted, `other` is not.
contract Target {
    uint256 public pinged;

    function ping(uint256 x) external payable {
        pinged = x;
    }

    function other() external {}
}

contract SessionKeyAccountTest is Test {
    SessionKeyAccount internal acct;
    Target internal target;

    address internal constant EP = address(0xE170);
    address internal constant ALICE = 0x4785Dca37A242F3D80f844CB0b143A687008a2B5;
    address internal constant BOB = address(0xB0B);

    address internal owner;
    uint256 internal ownerKey;
    address internal session;
    uint256 internal sessionKey;
    uint48 internal until;

    uint128 internal constant PER_OP = 0.0005 ether; // config/policy.json native.autoMaxPerTx
    uint128 internal constant TOTAL = 0.01 ether; // config/policy.json native.dailyBudget

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (session, sessionKey) = makeAddrAndKey("session");
        acct = new SessionKeyAccount(EP, owner);
        target = new Target();
        vm.deal(address(acct), 1 ether);
        until = uint48(block.timestamp + 1 days);
        _grant(session);
    }

    // ------------------------------------------------------------ helpers

    function _grant(address key) internal {
        address[] memory targets = new address[](2);
        targets[0] = ALICE;
        targets[1] = address(target);
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = bytes4(0); // plain value transfer
        selectors[1] = Target.ping.selector;
        vm.prank(owner);
        acct.grantSession(key, until, PER_OP, TOTAL, targets, selectors);
    }

    function _sign(uint256 key, bytes32 userOpHash) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _op(bytes memory callData, bytes memory signature) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.callData = callData;
        op.signature = signature;
    }

    function _exec(address to, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(SessionKeyAccount.execute, (to, value, data));
    }

    function _validate(bytes memory callData, uint256 key, bytes32 h) internal returns (uint256) {
        PackedUserOperation memory op = _op(callData, _sign(key, h));
        vm.prank(EP);
        return acct.validateUserOp(op, h, 0);
    }

    function _spent(address key) internal view returns (uint128 spent) {
        (,,,,, spent) = acct.sessions(key);
    }

    // ---------------------------------------------------------- happy path

    function test_OwnerSignatureIsAlwaysValid() public {
        assertEq(_validate(_exec(BOB, 1 ether, ""), ownerKey, keccak256("op")), 0);
    }

    function test_SessionInScope_ReturnsItsExpiry_AndCountsSpend() public {
        uint256 data = _validate(_exec(ALICE, PER_OP, ""), sessionKey, keccak256("op"));
        // ERC-4337 packing: aggregator (low 160 bits) = 0, validUntil next 48 bits, validAfter = 0.
        assertEq(uint160(data), 0);
        assertEq(uint48(data >> 160), until);
        assertEq(data >> 208, 0);
        assertEq(_spent(session), PER_OP);
    }

    function test_SessionCanCallAGrantedFunction() public {
        bytes memory call = abi.encodeCall(Target.ping, (42));
        assertEq(_validate(_exec(address(target), 0, call), sessionKey, keccak256("op")), uint256(until) << 160);
        vm.prank(EP);
        acct.execute(address(target), 0, call);
        assertEq(target.pinged(), 42);
    }

    function test_EntryPointExecutesAValueTransfer() public {
        uint256 before = ALICE.balance;
        vm.prank(EP);
        acct.execute(ALICE, PER_OP, "");
        assertEq(ALICE.balance - before, PER_OP);
    }

    // ------------------------------------------------------- rejection paths

    function test_UnknownSignerFailsValidation() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        assertEq(_validate(_exec(ALICE, 1, ""), strangerKey, keccak256("op")), 1);
    }

    function test_RevertWhen_TargetIsNotGranted() public {
        bytes memory cd = _exec(BOB, 1, "");
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.TargetNotAllowed.selector, BOB));
        _validate(cd, sessionKey, keccak256("op"));
    }

    function test_RevertWhen_SelectorIsNotGranted() public {
        bytes memory cd = _exec(address(target), 0, abi.encodeCall(Target.other, ()));
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.SelectorNotAllowed.selector, Target.other.selector));
        _validate(cd, sessionKey, keccak256("op"));
    }

    function test_RevertWhen_ValueAbovePerOpCap() public {
        bytes memory cd = _exec(ALICE, uint256(PER_OP) + 1, "");
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.OverPerOpCap.selector, uint256(PER_OP) + 1, uint256(PER_OP)));
        _validate(cd, sessionKey, keccak256("op"));
    }

    function test_RevertWhen_TotalCapIsUsedUp() public {
        // 0.01 / 0.0005 = 20 operations fit; the 21st does not.
        for (uint256 i = 0; i < 20; i++) {
            _validate(_exec(ALICE, PER_OP, ""), sessionKey, keccak256(abi.encode(i)));
        }
        assertEq(_spent(session), TOTAL);
        bytes memory cd = _exec(ALICE, PER_OP, "");
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.OverTotalCap.selector, uint256(TOTAL) + PER_OP, uint256(TOTAL)));
        _validate(cd, sessionKey, keccak256("last"));
    }

    function test_RevertWhen_CallIsNotExecute() public {
        bytes memory cd = abi.encodeCall(SessionKeyAccount.revokeSession, (session));
        vm.expectRevert(SessionKeyAccount.NotExecute.selector);
        _validate(cd, sessionKey, keccak256("op"));
    }

    function test_RevertWhen_SessionTargetsTheAccountItself() public {
        // A session must never reach grantSession through execute(self, ...).
        address[] memory none = new address[](0);
        bytes4[] memory noSel = new bytes4[](0);
        bytes memory regrant = abi.encodeCall(SessionKeyAccount.grantSession, (session, until, type(uint128).max, type(uint128).max, none, noSel));
        bytes memory cd = _exec(address(acct), 0, regrant);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.TargetNotAllowed.selector, address(acct)));
        _validate(cd, sessionKey, keccak256("op"));
    }

    function test_RevokedSessionFailsValidation() public {
        vm.prank(owner);
        acct.revokeSession(session);
        assertEq(_validate(_exec(ALICE, 1, ""), sessionKey, keccak256("op")), 1);
    }

    function test_RegrantDoesNotInheritTheOldScope() public {
        _validate(_exec(ALICE, PER_OP, ""), sessionKey, keccak256("op"));
        address[] memory onlyAlice = new address[](1);
        onlyAlice[0] = ALICE;
        bytes4[] memory onlyValue = new bytes4[](1);
        onlyValue[0] = bytes4(0);
        vm.prank(owner);
        acct.grantSession(session, until, PER_OP, TOTAL, onlyAlice, onlyValue);
        assertEq(_spent(session), 0);
        assertFalse(acct.isTargetAllowed(session, address(target)));
        assertFalse(acct.isSelectorAllowed(session, Target.ping.selector));
        bytes memory cd = _exec(address(target), 0, abi.encodeCall(Target.ping, (1)));
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.TargetNotAllowed.selector, address(target)));
        _validate(cd, sessionKey, keccak256("op2"));
    }

    function test_GrantRules() public {
        address[] memory none = new address[](0);
        bytes4[] memory noSel = new bytes4[](0);
        // Only the owner (or the account itself) can grant.
        vm.prank(session);
        vm.expectRevert(SessionKeyAccount.NotOwner.selector);
        acct.grantSession(BOB, until, 1, 1, none, noSel);
        // Expiry in the past, per-op above total, the owner as a session, zero key: refused.
        vm.startPrank(owner);
        vm.expectRevert(SessionKeyAccount.BadSession.selector);
        acct.grantSession(BOB, uint48(block.timestamp), 1, 1, none, noSel);
        vm.expectRevert(SessionKeyAccount.BadSession.selector);
        acct.grantSession(BOB, until, 2, 1, none, noSel);
        vm.expectRevert(SessionKeyAccount.BadSession.selector);
        acct.grantSession(owner, until, 1, 1, none, noSel);
        vm.expectRevert(SessionKeyAccount.BadSession.selector);
        acct.grantSession(address(0), until, 1, 1, none, noSel);
        address[] memory self = new address[](1);
        self[0] = address(acct);
        vm.expectRevert(SessionKeyAccount.BadSession.selector);
        acct.grantSession(BOB, until, 1, 1, self, noSel);
        vm.stopPrank();
    }

    function test_OnlyTheEntryPointCanValidate() public {
        PackedUserOperation memory op = _op(_exec(ALICE, 1, ""), _sign(sessionKey, keccak256("op")));
        vm.expectRevert(SessionKeyAccount.NotEntryPoint.selector);
        acct.validateUserOp(op, keccak256("op"), 0);
    }

    function test_OnlyEntryPointOrOwnerCanExecute() public {
        vm.prank(session);
        vm.expectRevert(SessionKeyAccount.NotEntryPointOrOwner.selector);
        acct.execute(BOB, 1, "");
    }

    function test_PrefundsTheEntryPoint() public {
        PackedUserOperation memory op = _op(_exec(ALICE, 1, ""), _sign(sessionKey, keccak256("op")));
        uint256 before = EP.balance;
        vm.prank(EP);
        acct.validateUserOp(op, keccak256("op"), 1 gwei);
        assertEq(EP.balance - before, 1 gwei);
    }

    function test_MalformedOrMalleableSignaturesFail() public {
        bytes32 h = keccak256("op");
        bytes memory good = _sign(sessionKey, h);
        // Truncated.
        bytes memory short = new bytes(64);
        for (uint256 i = 0; i < 64; i++) short[i] = good[i];
        PackedUserOperation memory op = _op(_exec(ALICE, 1, ""), short);
        vm.prank(EP);
        assertEq(acct.validateUserOp(op, h, 0), 1);
        // High-s twin of a valid signature (malleability) is refused.
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(good, 32))
            s := mload(add(good, 64))
            v := byte(0, mload(add(good, 96)))
        }
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        op = _op(_exec(ALICE, 1, ""), twin);
        vm.prank(EP);
        assertEq(acct.validateUserOp(op, h, 0), 1);
    }

    function testFuzz_ValueAboveThePerOpCapAlwaysReverts(uint256 value) public {
        value = bound(value, uint256(PER_OP) + 1, type(uint128).max);
        bytes memory cd = _exec(ALICE, value, "");
        vm.expectRevert(abi.encodeWithSelector(SessionKeyAccount.OverPerOpCap.selector, value, uint256(PER_OP)));
        _validate(cd, sessionKey, keccak256("fuzz"));
    }

    // --------------------------------------------- TypeScript cross-check

    /// The same operation `scripts/userop-vector.ts` hashes; both sides must agree.
    function test_UserOpHashMatchesTheTypeScriptHelper() public pure {
        bytes memory callData = abi.encodeCall(SessionKeyAccount.execute, (ALICE, 500000000000000, ""));
        bytes32 gasLimits = bytes32((uint256(150000) << 128) | 100000);
        bytes32 gasFees = bytes32((uint256(1000000) << 128) | 2000000000);
        bytes32 inner = keccak256(
            abi.encode(
                address(0x1111111111111111111111111111111111111111),
                uint256(7),
                keccak256(""),
                keccak256(callData),
                gasLimits,
                uint256(50000),
                gasFees,
                keccak256("")
            )
        );
        bytes32 h = keccak256(abi.encode(inner, address(0x0000000071727De22E5E9d8BAf0edAc6f37da032), uint256(84532)));
        assertEq(h, 0x4687b2b1383fb17ed174794aa26a060fadf872e1322a5f62007ef5e65d28dc44);
    }
}
