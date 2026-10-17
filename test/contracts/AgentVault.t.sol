// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../../contracts/AgentVault.sol";

/// @notice Foundry tests for the on-chain guardrails. Run with `forge test`.
/// These prove the claims in docs/SECURITY_SELF_ASSESSMENT.md: even a fully
/// compromised agent key cannot exceed the per-tx cap, the daily limit, or the
/// allowlist, and the owner can pause everything.
contract AgentVaultTest is Test {
    AgentVault internal vault;

    address internal constant AGENT = address(0xA11CE);
    address internal constant ALICE = address(0xA11CE1);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant MAX_PER_TX = 0.001 ether;
    uint256 internal constant DAILY_LIMIT = 0.0025 ether;

    function setUp() public {
        // 1 ETH is funded into the vault so spends have something to move.
        vault = new AgentVault{value: 1 ether}(AGENT, MAX_PER_TX, DAILY_LIMIT);
        vault.setRecipient(ALICE, true);
    }

    function test_agentSendsWithinLimits() public {
        vm.prank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);

        assertEq(ALICE.balance, 0.001 ether);
        assertEq(vault.spentToday(), 0.001 ether);
    }

    function test_nonAgentReverts() public {
        vm.prank(BOB);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.agentSend(payable(ALICE), 0.0005 ether);
    }

    function test_overPerTxCapReverts() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.OverPerTxCap.selector);
        vault.agentSend(payable(ALICE), MAX_PER_TX + 1);
    }

    function test_overDailyLimitReverts() public {
        vm.startPrank(AGENT);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vault.agentSend(payable(ALICE), 0.001 ether);
        vm.expectRevert(AgentVault.OverDailyLimit.selector);
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
        vm.expectRevert(AgentVault.IsPaused.selector);
        vault.agentSend(payable(ALICE), 0.0005 ether);
    }

    function test_disallowedRecipientReverts() public {
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.RecipientNotAllowed.selector);
        vault.agentSend(payable(BOB), 0.0005 ether);
    }

    function test_onlyOwnerCanChangeGuardrails() public {
        vm.prank(BOB);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setRecipient(BOB, true);

        vm.prank(BOB);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPaused(true);
    }

    function test_ownerCanWithdraw() public {
        uint256 before = address(this).balance;
        vault.withdraw(0.5 ether);
        assertEq(address(this).balance, before + 0.5 ether);
    }

    function test_vaultAcceptsEth() public {
        (bool ok, ) = address(vault).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1.1 ether);
    }

    /// @notice Fuzz: for any three send attempts, no sequence can push the vault
    /// past its daily limit; what recipients received always equals spentToday.
    function testFuzz_budgetCannotBeExceededByAnySequence(uint96 a, uint96 b, uint96 c) public {
        uint256[3] memory attempts = [uint256(a), uint256(b), uint256(c)];
        uint256 received;

        for (uint256 i = 0; i < attempts.length; i++) {
            // Mix of below-cap, exactly-at-cap and above-cap amounts.
            uint256 amount = attempts[i] % (MAX_PER_TX + 0.0005 ether);
            uint256 before = ALICE.balance;
            vm.prank(AGENT);
            try vault.agentSend(payable(ALICE), amount) {
                received += ALICE.balance - before;
            } catch {}
        }

        assertLe(vault.spentToday(), DAILY_LIMIT);
        assertEq(vault.spentToday(), received);
        assertEq(ALICE.balance, received);
        assertEq(address(vault).balance, 1 ether - received);
    }

    /// @notice Fuzz: a fully compromised agent key still cannot pay a recipient
    /// that was never allowlisted.
    function testFuzz_recipientMustBeAllowlisted(address who, uint96 amount) public {
        vm.assume(who != ALICE);
        uint256 sendAmount = uint256(amount) % (MAX_PER_TX + 1);
        vm.prank(AGENT);
        vm.expectRevert(AgentVault.RecipientNotAllowed.selector);
        vault.agentSend(payable(who), sendAmount);
    }

    // The test contract is the vault owner, so it must accept the ETH that
    // `withdraw` sends it; without this, the withdraw reverts with TransferFailed.
    receive() external payable {}
}
