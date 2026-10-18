// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentVaultV2} from "../contracts/AgentVaultV2.sol";

/// @notice Deploys AgentVaultV2 to Base Sepolia.
///
/// The owner key MUST be different from the agent key. The owner is the human who
/// sets the limits and grants session keys; the agent (root) key and any session
/// keys only ever call `agentSend` / `agentSendToken`.
///
///   export AGENT_ADDRESS=0x...                     # the agent's funded key
///   export VAULT_MAX_PER_TX=500000000000000        # 0.0005 ether
///   export VAULT_DAILY_LIMIT=10000000000000000     # 0.01 ether
///   export VAULT_FUNDING=10000000000000000         # optional, 0.01 ether
///   export VAULT_RECIPIENT=0x...                   # optional allowlisted payee
///   export VAULT_TOKEN=0x...                       # optional ERC-20 to allow
///   export VAULT_TOKEN_DAILY_LIMIT=1000000         # optional (6-decimal units)
///   forge script script/DeployAgentVaultV2.s.sol \
///     --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
///
/// Session keys are granted after deployment with `cast send` (owner key),
/// e.g. `grantSessionKey(agent, expiry, maxPerTx, dailyLimit, true, false, false)`.
contract DeployAgentVaultV2 is Script {
    function run() external returns (AgentVaultV2 vault) {
        address agent = vm.envAddress("AGENT_ADDRESS");
        uint256 maxPerTx = vm.envOr("VAULT_MAX_PER_TX", uint256(500_000_000_000_000)); // 0.0005 ether
        uint256 dailyLimit = vm.envOr("VAULT_DAILY_LIMIT", uint256(10_000_000_000_000_000)); // 0.01 ether
        uint256 funding = vm.envOr("VAULT_FUNDING", uint256(0));
        address recipient = vm.envOr("VAULT_RECIPIENT", address(0));
        address token = vm.envOr("VAULT_TOKEN", address(0));
        uint256 tokenDailyLimit = vm.envOr("VAULT_TOKEN_DAILY_LIMIT", uint256(0));

        vm.startBroadcast();
        vault = new AgentVaultV2{value: funding}(agent, maxPerTx, dailyLimit);
        if (recipient != address(0)) vault.setRecipient(recipient, true);
        if (token != address(0)) vault.setAllowedToken(token, true, tokenDailyLimit);
        vm.stopBroadcast();

        console2.log("AgentVaultV2 deployed at", address(vault));
        console2.log("agent", agent);
        console2.log("maxPerTx (wei)", maxPerTx);
        console2.log("dailyLimit (wei)", dailyLimit);
        if (recipient != address(0)) console2.log("allowlisted recipient", recipient);
        if (token != address(0)) console2.log("allowed token", token);
    }
}
