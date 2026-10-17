# Execution Evidence

Generated 2026-10-17T20:33:36.054Z from `data/audit.jsonl`.
Audit chain integrity: ✅ intact
## AgentVault (on-chain enforcement)

Vault: [0x098f7Cb9…](https://sepolia.basescan.org/address/0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388)
Deploy tx: [0xa63dea30…](https://sepolia.basescan.org/tx/0xa63dea30909b141cbfd44cb5c256e46559fc78dc15f502dfff1eb69a148a9b27) ✅ deployed
Owner allowlist (alice): [0x731ef8d4…](https://sepolia.basescan.org/tx/0x731ef8d423eb9fdf89f527650037891ab84832942642b5d21bb7dd39ff375c55) ✅ confirmed
Within-limit agent send (0.0002 ETH to alice): [0xfdfbb94d…](https://sepolia.basescan.org/tx/0xfdfbb94d4c684d5338fa527d9692dbb4d75e83c6fae75175845ec729a8f80212) ✅ confirmed
Over-cap agent call (0.001 ETH): [0x22da3e42…](https://sepolia.basescan.org/tx/0x22da3e428ad04d45ebff727dedafd1734a4c8730556765b37f0009f57d921be0) ❌ reverted on-chain
Non-allowlisted agent call: [0xd71e8143…](https://sepolia.basescan.org/tx/0xd71e8143568d1d418149b290ca0ddab5fc4015cebdfe3d5ef608ee47fb24e568) ❌ reverted on-chain


## On-chain transactions (16)

| Time (UTC) | Action | Amount | Tier | Result | Tx hash |
|---|---|---|---|---|---|
| 2026-10-15T13:40:10.988Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48151662 | [0x40299548…](https://sepolia.basescan.org/tx/0x40299548ddf85c221936ed4d8429b322e676e244bf835a7a3ccf22e531c62365) |
| 2026-10-15T14:11:09.534Z | erc20_transfer | 0.5 USDC | T1_AUTO | ✅ block 48152591 | [0xadf04893…](https://sepolia.basescan.org/tx/0xadf04893edfe4e46c6b5a23f19489c6192099633bd09547adaadcbf3e0e0246e) |
| 2026-10-15T14:17:58.983Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48152796 | [0x5d28cf87…](https://sepolia.basescan.org/tx/0x5d28cf873bb8016ab8a8b70596850ceed330cf2ac652405fab103b40692b1870) |
| 2026-10-15T14:18:25.427Z | erc20_transfer | 0.5 USDC | T1_AUTO | ✅ block 48152809 | [0x3d0b64e7…](https://sepolia.basescan.org/tx/0x3d0b64e770ce3a7258ac86370bb2f389916a05d0e041cb36887bd46e0e600be4) |
| 2026-10-15T15:08:08.372Z | erc20_transfer | 0.5 USDC | T2_CONFIRM | ✅ block 48154301 | [0x2aa29a19…](https://sepolia.basescan.org/tx/0x2aa29a198ea1c4874dbe4bbfb10662df58704f8c1b923344097b13ebc2c0fbca) |
| 2026-10-16T16:28:19.263Z | erc20_approve | 0.5 USDC | T1_AUTO | ✅ block 48199906 | [0xf43f810c…](https://sepolia.basescan.org/tx/0xf43f810cf632e8501ab0d469a6f176ee386fe6d08e4fe0564bf3ce0616b14b6d) |
| 2026-10-16T16:28:28.119Z | swap | 0.5 USDC | T1_AUTO | ✅ block 48199910 | [0x8c85259b…](https://sepolia.basescan.org/tx/0x8c85259bda1f0829cd23a46591acb4184e0513e08040beaeb19c67207f53c3d5) |
| 2026-10-16T18:56:54.682Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48204364 | [0x7d3a9a88…](https://sepolia.basescan.org/tx/0x7d3a9a88a34e88a14bc2161245be6d6a1daf9a2740e9d8f7d551b306aa85d2a4) |
| 2026-10-16T18:57:30.124Z | native_transfer | 0.002 ETH | T2_CONFIRM | ✅ block 48204382 | [0xe0e69dc5…](https://sepolia.basescan.org/tx/0xe0e69dc5e8395e1e2060318cbec1e85256a74e498252683f9b7f55b7709e2fca) |
| 2026-10-16T18:58:10.880Z | erc20_approve | 0.5 USDC | T1_AUTO | ✅ block 48204402 | [0x340871f2…](https://sepolia.basescan.org/tx/0x340871f2aff3a80bcb4c1fc789e853a2ccf838d053535b4bfe7641759da9ad13) |
| 2026-10-16T18:58:18.764Z | swap | 0.5 USDC | T1_AUTO | ✅ block 48204406 | [0xbf76a7bb…](https://sepolia.basescan.org/tx/0xbf76a7bbe12be71be821618bc35b55315a9fac09a658ac1589790015405461f9) |
| 2026-10-16T19:06:06.512Z | native_transfer | 0.0001 ETH | T1_AUTO | ✅ block 48204640 | [0xd7bc3fab…](https://sepolia.basescan.org/tx/0xd7bc3fab2f93caa1b31645b0388d9910a3dc8607f769529b9b43dfc83853d788) |
| 2026-10-17T16:53:26.599Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48243860 | [0x68563461…](https://sepolia.basescan.org/tx/0x6856346118bbe4bb4ca8487e3d3a1f157d3a0a742234b5a6d7ffc0f3462f6113) |
| 2026-10-17T19:51:07.596Z | native_transfer | 0.0002 ETH | T1_AUTO | ✅ block 48249190 | [0xc24761c4…](https://sepolia.basescan.org/tx/0xc24761c479c3455352fda3e6778d6bf6cc863b8512ae750f53ab79fef1f6dad0) |
| 2026-10-17T20:32:35.295Z | native_transfer | 0.0001 ETH | T1_AUTO | ✅ block 48250434 | [0x9ba0ae07…](https://sepolia.basescan.org/tx/0x9ba0ae077d760706b6938da968593d610376312654198a29e134de93d573dc73) |
| 2026-10-17T20:32:52.909Z | native_transfer | 0.0001 ETH | T2_CONFIRM | ✅ block 48250443 | [0x32cc4187…](https://sepolia.basescan.org/tx/0x32cc41871fd959c4dc7f13d69fae0c55ba26496367382b18478145216536583b) |

## Blocked by policy (5)

- 2026-10-15T13:42:56.732Z: 1 ETH exceeds the per-transaction hard cap of 0.005 ETH.
- 2026-10-16T15:57:36.585Z: Unlimited token approvals are forbidden by policy.
- 2026-10-16T18:56:16.396Z: 1 ETH exceeds the per-transaction hard cap of 0.005 ETH.
- 2026-10-16T18:56:54.387Z: Unlimited token approvals are forbidden by policy.
- 2026-10-16T18:58:54.400Z: Kill switch is on: the wallet is paused.
