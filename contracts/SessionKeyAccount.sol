// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-4337 v0.7 packed user operation (the struct EntryPoint v0.7 passes
/// to `validateUserOp`).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @title SessionKeyAccount
/// @notice A minimal ERC-4337 (EntryPoint v0.7) smart account for an AI agent.
///
/// The owner key can do anything. The agent gets a **session key** instead: the
/// owner grants it a scope (allowed targets, allowed function selectors, a
/// per-operation value cap, a total value cap and an expiry), and
/// `validateUserOp` refuses any user operation signed by that key that steps
/// outside the scope. A stolen session key can therefore only call the
/// allowlisted contracts and functions, never more than its caps, and only until
/// it expires or the owner revokes it.
///
/// Design notes, all pinned down by `test/contracts/SessionKeyAccount.t.sol`:
///  - Session operations must be `execute(target, value, data)`; anything else
///    (including a call to the account itself, which could re-grant scope) is
///    refused, so a session key can never widen its own permissions.
///  - Expiry is enforced the ERC-4337 way: the key's `validUntil` is returned in
///    the validation data and the EntryPoint refuses the operation after it.
///    Validation never reads `block.timestamp` (banned by the ERC-7562 rules).
///  - Value is counted when the operation is validated, so a failing execution
///    still uses up the session's total budget (fail closed, like the off-chain
///    policy's daily budget).
///  - A plain value transfer (empty calldata) is selector `0x00000000` and must
///    be granted explicitly.
contract SessionKeyAccount {
    address public immutable entryPoint;
    address public owner;

    /// ERC-4337: returned when the signature does not belong to an allowed signer.
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    /// secp256k1n / 2: higher `s` values are malleable and refused.
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Session {
        bool active;
        uint48 validUntil;
        // Bumped on every grant, so a re-granted key never inherits old targets/selectors.
        uint32 epoch;
        uint128 maxPerOp;
        uint128 maxTotal;
        uint128 spent;
    }

    mapping(address => Session) public sessions;
    mapping(address => mapping(uint32 => mapping(address => bool))) internal _target;
    mapping(address => mapping(uint32 => mapping(bytes4 => bool))) internal _selector;

    event SessionGranted(address indexed key, uint48 validUntil, uint128 maxPerOp, uint128 maxTotal);
    event SessionRevoked(address indexed key);
    event SessionSpend(address indexed key, address indexed target, uint256 value);
    event OwnerChanged(address indexed owner);

    error NotEntryPoint();
    error NotOwner();
    error NotEntryPointOrOwner();
    error BadSession();
    error NotExecute();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error OverPerOpCap(uint256 value, uint256 cap);
    error OverTotalCap(uint256 wouldSpend, uint256 cap);
    error CallFailed();

    constructor(address entryPoint_, address owner_) {
        entryPoint = entryPoint_;
        owner = owner_;
    }

    receive() external payable {}

    modifier onlyOwner() {
        // The owner acts directly, or through an owner-signed user operation
        // (EntryPoint -> execute -> this contract).
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Grants (or replaces) a session key with a fresh budget.
    function grantSession(
        address key,
        uint48 validUntil,
        uint128 maxPerOp,
        uint128 maxTotal,
        address[] calldata targets,
        bytes4[] calldata selectors
    ) external onlyOwner {
        if (key == address(0) || key == owner || validUntil == 0 || maxPerOp > maxTotal) revert BadSession();
        if (validUntil <= block.timestamp) revert BadSession();
        uint32 epoch = sessions[key].epoch + 1;
        sessions[key] = Session({active: true, validUntil: validUntil, epoch: epoch, maxPerOp: maxPerOp, maxTotal: maxTotal, spent: 0});
        for (uint256 i = 0; i < targets.length; i++) {
            // Calling the account itself could re-grant scope; never allowed.
            if (targets[i] == address(this)) revert BadSession();
            _target[key][epoch][targets[i]] = true;
        }
        for (uint256 i = 0; i < selectors.length; i++) {
            _selector[key][epoch][selectors[i]] = true;
        }
        emit SessionGranted(key, validUntil, maxPerOp, maxTotal);
    }

    /// @notice Revokes a session immediately; its next operation fails validation.
    function revokeSession(address key) external onlyOwner {
        sessions[key].active = false;
        emit SessionRevoked(key);
    }

    function isTargetAllowed(address key, address target) external view returns (bool) {
        return _target[key][sessions[key].epoch][target];
    }

    function isSelectorAllowed(address key, bytes4 selector) external view returns (bool) {
        return _selector[key][sessions[key].epoch][selector];
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert BadSession();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    // -------------------------------------------------------------- ERC-4337

    /// @notice EntryPoint v0.7 validation. Returns 0 for the owner, the packed
    /// `validUntil` for an in-scope session operation, or SIG_VALIDATION_FAILED
    /// for an unknown or revoked signer. Out-of-scope session operations revert.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData)
    {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        validationData = _validate(userOp, userOpHash);
        if (missingAccountFunds > 0) {
            // Prefund the EntryPoint; it refunds any excess. A failure is the EntryPoint's to handle.
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok);
        }
    }

    function _validate(PackedUserOperation calldata userOp, bytes32 userOpHash) internal returns (uint256) {
        address signer = _recover(_ethSignedHash(userOpHash), userOp.signature);
        if (signer == address(0)) return SIG_VALIDATION_FAILED;
        if (signer == owner) return 0;

        Session storage s = sessions[signer];
        if (!s.active) return SIG_VALIDATION_FAILED;

        (address target, uint256 value, bytes4 selector) = _decodeExecute(userOp.callData);
        if (target == address(this) || !_target[signer][s.epoch][target]) revert TargetNotAllowed(target);
        if (!_selector[signer][s.epoch][selector]) revert SelectorNotAllowed(selector);
        if (value > s.maxPerOp) revert OverPerOpCap(value, s.maxPerOp);
        uint256 wouldSpend = uint256(s.spent) + value;
        if (wouldSpend > s.maxTotal) revert OverTotalCap(wouldSpend, s.maxTotal);
        s.spent = uint128(wouldSpend);
        emit SessionSpend(signer, target, value);

        // ERC-4337 validation data: aggregator (0) | validUntil << 160 | validAfter (0) << 208.
        return uint256(s.validUntil) << 160;
    }

    /// @dev Session operations must be exactly `execute(address,uint256,bytes)`.
    function _decodeExecute(bytes calldata callData)
        internal
        pure
        returns (address target, uint256 value, bytes4 selector)
    {
        if (callData.length < 4 || bytes4(callData[:4]) != this.execute.selector) revert NotExecute();
        bytes memory inner;
        (target, value, inner) = abi.decode(callData[4:], (address, uint256, bytes));
        if (inner.length == 0) {
            selector = bytes4(0);
        } else if (inner.length >= 4) {
            selector = bytes4(inner);
        } else {
            revert SelectorNotAllowed(bytes4(0xffffffff));
        }
    }

    /// @notice Runs a call. Only the EntryPoint (after validation) or the owner.
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != entryPoint && msg.sender != owner) revert NotEntryPointOrOwner();
        (bool ok,) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
    }

    // --------------------------------------------------------------- helpers

    function _ethSignedHash(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    /// @dev ecrecover over a 65-byte (r, s, v) signature; 0 for anything malformed or malleable.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
