# Execution Evidence

Generated 2026-10-16T17:45:52.233Z from `data/audit.jsonl`.
Audit chain integrity: ✅ intact
## AgentVault (on-chain enforcement)

Vault: [0x098f7Cb9…](https://sepolia.basescan.org/address/0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388)
Deploy tx: [0xa63dea30…](https://sepolia.basescan.org/tx/0xa63dea30909b141cbfd44cb5c256e46559fc78dc15f502dfff1eb69a148a9b27) ✅ deployed
Over-limit agent call: [0xd71e8143…](https://sepolia.basescan.org/tx/0xd71e8143568d1d418149b290ca0ddab5fc4015cebdfe3d5ef608ee47fb24e568) ❌ reverted on-chain (limits hold even with a compromised agent key)


## On-chain transactions (7)

| Time (UTC) | Action | Amount | Tier | Result | Tx hash |
|---|---|---|---|---|---|
| 2026-10-15T13:40:10.988Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48151662 | [0x40299548…](https://sepolia.basescan.org/tx/0x40299548ddf85c221936ed4d8429b322e676e244bf835a7a3ccf22e531c62365) |
| 2026-10-15T14:11:09.534Z | erc20_transfer | 0.5 USDC | T1_AUTO | ✅ block 48152591 | [0xadf04893…](https://sepolia.basescan.org/tx/0xadf04893edfe4e46c6b5a23f19489c6192099633bd09547adaadcbf3e0e0246e) |
| 2026-10-15T14:17:58.983Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48152796 | [0x5d28cf87…](https://sepolia.basescan.org/tx/0x5d28cf873bb8016ab8a8b70596850ceed330cf2ac652405fab103b40692b1870) |
| 2026-10-15T14:18:25.427Z | erc20_transfer | 0.5 USDC | T1_AUTO | ✅ block 48152809 | [0x3d0b64e7…](https://sepolia.basescan.org/tx/0x3d0b64e770ce3a7258ac86370bb2f389916a05d0e041cb36887bd46e0e600be4) |
| 2026-10-15T15:08:08.372Z | erc20_transfer | 0.5 USDC | T2_CONFIRM | ✅ block 48154301 | [0x2aa29a19…](https://sepolia.basescan.org/tx/0x2aa29a198ea1c4874dbe4bbfb10662df58704f8c1b923344097b13ebc2c0fbca) |
| 2026-10-16T16:28:19.263Z | erc20_approve | 0.5 USDC | T1_AUTO | ✅ block 48199906 | [0xf43f810c…](https://sepolia.basescan.org/tx/0xf43f810cf632e8501ab0d469a6f176ee386fe6d08e4fe0564bf3ce0616b14b6d) |
| 2026-10-16T16:28:28.119Z | swap | 0.5 USDC | T1_AUTO | ✅ block 48199910 | [0x8c85259b…](https://sepolia.basescan.org/tx/0x8c85259bda1f0829cd23a46591acb4184e0513e08040beaeb19c67207f53c3d5) |

## Blocked by policy (2)

- 2026-10-15T13:42:56.732Z: 1 ETH exceeds the per-transaction hard cap of 0.005 ETH.
- 2026-10-16T15:57:36.585Z: Unlimited token approvals are forbidden by policy.
