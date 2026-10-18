// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVaultV2} from "../../contracts/AgentVaultV2.sol";

/// @notice A minimal ERC-20, just enough for the token paths.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A recipient that tries to re-enter `agentSend` while being paid. Used
/// to prove the reentrancy guard blocks the nested call.
contract ReentrantRecipient {
    AgentVaultV2 internal vault;
    bool internal attempted;
    bool internal blocked;

    constructor(AgentVaultV2 v) {
        vault = v;
    }

    function wasBlocked() external view returns (bool) {
        return blocked;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        (bool ok, bytes memory data) = address(vault).call(
            abi.encodeWithSignature("agentSend(address,uint256)", address(this), uint256(1))
        );
        blocked = !ok && keccak256(data) == keccak256(abi.encodeWithSelector(AgentVaultV2.Reentrancy.selector));
    }
}

/// @notice Foundry tests for AgentVaultV2. Run with `forge test`.
/// They pin the three invariants in the contract header: session caps never
/// exceed the vault's and the vault re-checks them, a restricted session with no
/// targets pays nobody, and no path can be re-entered.
contract AgentVaultV2Test is Test {
    AgentVaultV2 internal vault;
    MockERC20 internal token;

    address internal constant AGENT = address(0xA11CE);
    address internal constant SESSION = address(0x5E55);
    address internal constant ALICE = address(0xA11CE1);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant FUNDING = 1 ether;
    uint256 internal constant MAX_PER_TX = 0.001 ether;
    uint256 internal constant DAILY_LIMIT = 0.0025 ether;
    uint256 internal constant SESSION_MAX_PER_TX = 0.0005 ether;
    uint256 internal constant SESSION_DAILY = 0.001 ether;

    function setUp() public {
        vault = new AgentVaultV2{value: FUNDING}(AGENT, MAX_PER_TX, DAILY_LIMIT);
        vault.setRecipient(ALICE, true);
        token = new MockERC20();
        token.mint(address(vault), 1_000_000);
        vault.setAllowedToken(address(token), true, 1_000);
    }

    /// Grants the default native-only, unrestricted session to `key`.
    function grantNativeSession(address key) internal {
        vault.grantSessionKey(key, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, false);
    }

    // ---- v1 parity: the root agent path ----

    function test_rootAgentSendsWithinLimits() public {
        vm.prank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);
        assertEq(ALICE.balance, 0.001 ether);
        assertEq(vault.spentToday(), 0.001 ether);
    }

    function test_nonAgentReverts() public {
        vm.prank(BOB);
        vm.expectRevert(AgentVaultV2.NotAgent.selector);
        vault.agentSend(payable(ALICE), 0.0005 ether);
    }

    function test_overPerTxCapReverts() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.OverPerTxCap.selector);
        vault.agentSend(payable(ALICE), MAX_PER_TX + 1);
    }

    function test_overDailyLimitReverts() public {
        vm.startPrank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vm.expectRevert(AgentVaultV2.OverDailyLimit.selector);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vm.stopPrank();
    }

    function test_dailyLimitResetsAfterOneDay() public {
        vm.prank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);
        assertEq(vault.spentToday(), 0.001 ether);
    }

    function test_pausedRevertsEverything() public {
        vault.setPaused(true);
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.IsPaused.selector);
        vault.agentSend(payable(ALICE), 0.0005 ether);
    }

    function test_disallowedRecipientReverts() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.RecipientNotAllowed.selector);
        vault.agentSend(payable(BOB), 0.0005 ether);
    }

    function test_zeroAmountReverts() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.ZeroAmount.selector);
        vault.agentSend(payable(ALICE), 0);
    }

    function test_vaultAcceptsEth() public {
        (bool ok, ) = address(vault).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1.1 ether);
    }

    // ---- session keys ----

    function test_grantedSessionCanSendWithinItsCaps() public {
        grantNativeSession(SESSION);
        vm.prank(SESSION);
        vault.agentSend(payable(ALICE), 0.0005 ether);
        assertEq(ALICE.balance, 0.0005 ether);
        assertEq(vault.spentToday(), 0.0005 ether);
    }

    function test_sessionPerTxCapIsLowerThanVault() public {
        grantNativeSession(SESSION);
        // Above the session cap but under the vault cap: still refused.
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.SessionOverPerTxCap.selector);
        vault.agentSend(payable(ALICE), 0.0008 ether);
    }

    function test_sessionDailyCapBinds() public {
        grantNativeSession(SESSION);
        vm.startPrank(SESSION);
        vault.agentSend(payable(ALICE), 0.0005 ether);
        vault.agentSend(payable(ALICE), 0.0005 ether);
        vm.expectRevert(AgentVaultV2.SessionOverDailyLimit.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
        vm.stopPrank();
    }

    function test_grantRejectsCapsAboveVault() public {
        vm.expectRevert(AgentVaultV2.SessionCapsAboveVault.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), MAX_PER_TX + 1, SESSION_DAILY, true, false, false);

        vm.expectRevert(AgentVaultV2.SessionCapsAboveVault.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, DAILY_LIMIT + 1, true, false, false);
    }

    function test_grantRequiresFutureExpiry() public {
        vm.expectRevert(AgentVaultV2.BadExpiry.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, false);
    }

    function test_grantRequiresAtLeastOneCapability() public {
        vm.expectRevert(AgentVaultV2.SelectorNotAllowed.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, false, false, false);
    }

    function test_expiredSessionReverts() public {
        grantNativeSession(SESSION);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.SessionExpired.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
    }

    function test_revokedSessionReverts() public {
        grantNativeSession(SESSION);
        vault.revokeSessionKey(SESSION);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.NotAgent.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
    }

    /// Lowering a vault cap must immediately tighten every existing session: the
    /// send path re-checks the vault caps, so a session granted under a looser
    /// vault cap cannot keep sending.
    function test_loweringVaultCapTightensExistingSession() public {
        grantNativeSession(SESSION);
        vault.setLimits(0.0001 ether, DAILY_LIMIT);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.OverPerTxCap.selector);
        vault.agentSend(payable(ALICE), 0.0005 ether);
    }

    // ---- restricted targets: fail closed on an empty set ----

    function test_restrictedSessionWithNoTargetsPaysNobody() public {
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, true);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.RecipientNotAllowed.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
    }

    function test_restrictedSessionPaysOnlyItsTargets() public {
        vault.setRecipient(BOB, true);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, true);
        vault.setSessionTarget(SESSION, ALICE, true);

        vm.prank(SESSION);
        vault.agentSend(payable(ALICE), 0.0001 ether);
        assertEq(ALICE.balance, 0.0001 ether);

        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.RecipientNotAllowed.selector);
        vault.agentSend(payable(BOB), 0.0001 ether);
    }

    function test_unrestrictedSessionStillObeysVaultAllowlist() public {
        grantNativeSession(SESSION);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.RecipientNotAllowed.selector);
        vault.agentSend(payable(BOB), 0.0001 ether);
    }

    // ---- token paths and selector binding ----

    function test_rootAgentCanSendAllowedToken() public {
        vm.prank(AGENT);
        vault.agentSendToken(address(token), ALICE, 100);
        assertEq(token.balanceOf(ALICE), 100);
        (, , uint256 tokenSpent, ) = vault.tokenRules(address(token));
        assertEq(tokenSpent, 100);
    }

    function test_tokenMustBeAllowed() public {
        MockERC20 other = new MockERC20();
        other.mint(address(vault), 100);
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.TokenNotAllowed.selector);
        vault.agentSendToken(address(other), ALICE, 1);
    }

    function test_tokenRecipientMustBeVaultAllowed() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVaultV2.RecipientNotAllowed.selector);
        vault.agentSendToken(address(token), BOB, 1);
    }

    function test_tokenDailyLimitAndReset() public {
        vault.setAllowedToken(address(token), true, 150);
        vm.startPrank(AGENT);
        vault.agentSendToken(address(token), ALICE, 100);
        vm.expectRevert(AgentVaultV2.OverDailyLimit.selector);
        vault.agentSendToken(address(token), ALICE, 100);
        vm.warp(block.timestamp + 1 days);
        vault.agentSendToken(address(token), ALICE, 100);
        vm.stopPrank();
        assertEq(token.balanceOf(ALICE), 200);
    }

    function test_nativeOnlySessionCannotSendToken() public {
        vault.setSessionToken(SESSION, address(token), true);
        grantNativeSession(SESSION); // canSendNative only
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.SelectorNotAllowed.selector);
        vault.agentSendToken(address(token), ALICE, 1);
    }

    function test_tokenOnlySessionCannotSendNative() public {
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, false, true, false);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.SelectorNotAllowed.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
    }

    function test_sessionTokenMustBeGranted() public {
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, false, true, false);
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.TokenNotAllowed.selector);
        vault.agentSendToken(address(token), ALICE, 1);
    }

    function test_sessionCanSendGrantedToken() public {
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, false, true, false);
        vault.setSessionToken(SESSION, address(token), true);
        vm.prank(SESSION);
        vault.agentSendToken(address(token), ALICE, 50);
        assertEq(token.balanceOf(ALICE), 50);
    }

    // ---- reentrancy ----

    function test_reentrancyIsBlocked() public {
        ReentrantRecipient attacker = new ReentrantRecipient(vault);
        vault.setRecipient(address(attacker), true);
        vault.grantSessionKey(address(attacker), uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, false);

        vm.prank(AGENT);
        vault.agentSend(payable(address(attacker)), 0.0005 ether);

        assertTrue(attacker.wasBlocked(), "nested agentSend should revert with Reentrancy");
        // Only the outer spend was accounted.
        assertEq(vault.spentToday(), 0.0005 ether);
    }

    // ---- owner controls ----

    function test_onlyOwnerCanChangeGuardrails() public {
        vm.startPrank(BOB);
        vm.expectRevert(AgentVaultV2.NotOwner.selector);
        vault.setRecipient(BOB, true);
        vm.expectRevert(AgentVaultV2.NotOwner.selector);
        vault.setPaused(true);
        vm.expectRevert(AgentVaultV2.NotOwner.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), SESSION_MAX_PER_TX, SESSION_DAILY, true, false, false);
        vm.expectRevert(AgentVaultV2.NotOwner.selector);
        vault.revokeSessionKey(SESSION);
        vm.expectRevert(AgentVaultV2.NotOwner.selector);
        vault.setAllowedToken(address(token), true, 1);
        vm.stopPrank();
    }

    function test_ownerCanWithdraw() public {
        uint256 before = address(this).balance;
        vault.withdraw(0.5 ether);
        assertEq(address(this).balance, before + 0.5 ether);
    }

    function test_ownerCanWithdrawToken() public {
        vault.withdrawToken(address(token), 100);
        assertEq(token.balanceOf(address(this)), 100);
    }

    // ---- fuzz: the ledgers can never be overdrawn ----

    /// @notice Mixing root-agent and session spends, the vault ledger can never
    /// exceed the vault daily limit, and what recipients received always equals
    /// `spentToday`.
    function testFuzz_mixedLedgerNeverExceedsVaultDaily(uint96 a, uint96 b, uint96 c, uint96 d) public {
        grantNativeSession(SESSION);
        uint256[4] memory raw = [uint256(a), uint256(b), uint256(c), uint256(d)];
        uint256 received;

        for (uint256 i = 0; i < raw.length; i++) {
            uint256 amount = raw[i] % (MAX_PER_TX + 0.0005 ether);
            uint256 before = ALICE.balance;
            if (i % 2 == 0) vm.prank(AGENT);
            else vm.prank(SESSION);
            try vault.agentSend(payable(ALICE), amount) {
                received += ALICE.balance - before;
            } catch {}
        }

        assertLe(vault.spentToday(), DAILY_LIMIT);
        assertEq(vault.spentToday(), received);
        assertEq(ALICE.balance, received);
        assertEq(address(vault).balance, FUNDING - received);
    }

    /// @notice For any amount, a session can never exceed its own per-tx cap.
    function testFuzz_sessionPerTxCap(uint96 amount) public {
        grantNativeSession(SESSION);
        uint256 value = uint256(amount) % (MAX_PER_TX + 1);
        vm.prank(SESSION);
        if (value == 0) {
            vm.expectRevert(AgentVaultV2.ZeroAmount.selector);
            vault.agentSend(payable(ALICE), 0);
        } else if (value > SESSION_MAX_PER_TX) {
            vm.expectRevert(AgentVaultV2.SessionOverPerTxCap.selector);
            vault.agentSend(payable(ALICE), value);
        } else {
            vault.agentSend(payable(ALICE), value);
            assertEq(vault.spentToday(), value);
        }
    }

    /// @notice Any time at or after a session's expiry, the session reverts.
    function testFuzz_expiredSessionAlwaysReverts(uint40 delay) public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vault.grantSessionKey(SESSION, expiry, SESSION_MAX_PER_TX, SESSION_DAILY, true, false, false);
        vm.warp(uint256(expiry) + (uint256(delay) % 3650 days));
        vm.prank(SESSION);
        vm.expectRevert(AgentVaultV2.SessionExpired.selector);
        vault.agentSend(payable(ALICE), 0.0001 ether);
    }

    /// @notice No grant can ever carry caps above the vault's.
    function testFuzz_grantRejectsCapsAboveVault(uint96 extra) public {
        uint256 tooBig = MAX_PER_TX + 1 + (uint256(extra) % 1000 ether);
        vm.expectRevert(AgentVaultV2.SessionCapsAboveVault.selector);
        vault.grantSessionKey(SESSION, uint64(block.timestamp + 1 days), tooBig, SESSION_DAILY, true, false, false);
    }

    // The test contract is the vault owner, so it must accept the ETH that
    // `withdraw` sends it.
    receive() external payable {}
}
