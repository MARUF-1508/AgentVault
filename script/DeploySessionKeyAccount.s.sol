// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SessionKeyAccount} from "../contracts/SessionKeyAccount.sol";

/// @notice Deploys the ERC-4337 SessionKeyAccount (EntryPoint v0.7) to Base Sepolia
/// and, optionally, grants the agent a session key that mirrors config/policy.json.
///
/// Run with the OWNER key (never the agent's). OWNER_ADDRESS must be that key's
/// address; granting the session from any other broadcaster reverts (NotOwner).
///
///   export OWNER_ADDRESS=0x...                      # address of --private-key
///   export SESSION_KEY=0x...                        # the agent's session-key address
///   export SESSION_RECIPIENT=0x...                  # e.g. alice from the allowlist
///   export SESSION_MAX_PER_OP=500000000000000       # 0.0005 ether (native.autoMaxPerTx)
///   export SESSION_MAX_TOTAL=10000000000000000      # 0.01 ether (native.dailyBudget)
///   export SESSION_HOURS=24
///   export ACCOUNT_FUNDING=10000000000000000        # optional, 0.01 ether
///   forge script script/DeploySessionKeyAccount.s.sol \
///     --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
///
/// The agent then builds and signs user operations with src/aa/userop.ts and
/// submits them through any v0.7 bundler.
contract DeploySessionKeyAccount is Script {
    address internal constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external returns (SessionKeyAccount account) {
        address owner = vm.envAddress("OWNER_ADDRESS");
        address sessionKey = vm.envOr("SESSION_KEY", address(0));
        address recipient = vm.envOr("SESSION_RECIPIENT", address(0));
        uint256 maxPerOp = vm.envOr("SESSION_MAX_PER_OP", uint256(500_000_000_000_000));
        uint256 maxTotal = vm.envOr("SESSION_MAX_TOTAL", uint256(10_000_000_000_000_000));
        uint256 hoursValid = vm.envOr("SESSION_HOURS", uint256(24));
        uint256 funding = vm.envOr("ACCOUNT_FUNDING", uint256(0));

        vm.startBroadcast();
        account = new SessionKeyAccount(ENTRYPOINT_V07, owner);
        if (funding > 0) {
            (bool ok,) = address(account).call{value: funding}("");
            require(ok, "funding failed");
        }
        if (sessionKey != address(0) && recipient != address(0)) {
            address[] memory targets = new address[](1);
            targets[0] = recipient;
            bytes4[] memory selectors = new bytes4[](1);
            selectors[0] = bytes4(0); // plain value transfers only
            account.grantSession(
                sessionKey, uint48(block.timestamp + hoursValid * 1 hours), uint128(maxPerOp), uint128(maxTotal), targets, selectors
            );
        }
        vm.stopBroadcast();

        console2.log("SessionKeyAccount deployed at", address(account));
        console2.log("owner", owner);
        if (sessionKey != address(0)) console2.log("session key", sessionKey);
    }
}
