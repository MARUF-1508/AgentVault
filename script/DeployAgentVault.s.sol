// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentVault} from "../contracts/AgentVault.sol";

/// @notice Deploys AgentVault to Base Sepolia.
///
/// The owner key MUST be different from the agent key. The owner is the human
/// who sets the limits; the agent key only ever calls `agentSend`.
///
///   export AGENT_ADDRESS=0x...            # the agent's funded key
///   export VAULT_MAX_PER_TX=500000000000000      # 0.0005 ether
///   export VAULT_DAILY_LIMIT=10000000000000000   # 0.01 ether
///   export VAULT_FUNDING=10000000000000000       # optional, 0.01 ether
///   forge script script/DeployAgentVault.s.sol \
///     --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
contract DeployAgentVault is Script {
    function run() external returns (AgentVault vault) {
        address agent = vm.envAddress("AGENT_ADDRESS");
        uint256 maxPerTx = vm.envOr("VAULT_MAX_PER_TX", uint256(500_000_000_000_000)); // 0.0005 ether
        uint256 dailyLimit = vm.envOr("VAULT_DAILY_LIMIT", uint256(10_000_000_000_000_000)); // 0.01 ether
        uint256 funding = vm.envOr("VAULT_FUNDING", uint256(0));

        vm.startBroadcast();
        vault = new AgentVault{value: funding}(agent, maxPerTx, dailyLimit);
        vm.stopBroadcast();

        console2.log("AgentVault deployed at", address(vault));
        console2.log("agent", agent);
        console2.log("maxPerTx (wei)", maxPerTx);
        console2.log("dailyLimit (wei)", dailyLimit);
    }
}
