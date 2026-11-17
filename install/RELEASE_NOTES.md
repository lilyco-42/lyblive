## 一键安装

Linux / macOS:

```bash
curl -fsSL https://github.com/lilyco-42/lyblive/releases/latest/download/install.sh | sh
```

Windows (PowerShell，二选一):

```powershell
irm https://github.com/lilyco-42/lyblive/releases/latest/download/install.ps1 | iex
```

可选参数：`LYBLIVE_VERSION=v0.1.3` 指定版本；Linux/macOS 可用 `LYBLIVE_BIN_DIR` 指定安装目录。

## 资产

| 平台 | 文件 |
| --- | --- |
| Linux x86_64 | `lyblive-linux-x86_64` |
| Windows x86_64 | `lyblive-windows-x86_64.exe` |
| macOS arm64 | `lyblive-macos` |
| Android aarch64 | `lyblive-android-aarch64` |
| Android x86_64 | `lyblive-android-x86_64` |
| 校验和 | `SHA256SUMS` |
| 安装脚本 | `install.sh` / `install.ps1` |

二进制未签名，请用同页 `SHA256SUMS` 校验：`sha256sum -c SHA256SUMS`。

## 手机 / 平板（iOS、鸿蒙、Android）

不安装二进制。电脑上跑 `lyblive --web`，再走 USB 端口转发：

```bash
adb reverse tcp:8765 tcp:8765     # Android
iproxy 8765 8765                  # iOS (libimobiledevice)
hdc rport tcp:8765 tcp:8765       # 鸿蒙
```

手机浏览器打开 `http://127.0.0.1:8765/` 即可。端口转发只走 USB，不开放局域网端口，也不改变后端只监听 `127.0.0.1` 的安全策略。

## 使用

1. `lyblive --web` → 浏览器 `http://127.0.0.1:8765/` → 扫码登录 B 站
2. 「房间」改标题/分区/公告；「直播」开播、停播、复制推流地址与密钥（默认打码）
3. OBS 集成：退出 OBS 后 `lyblive --obs-install`，重开即出现 lyblive 面板
4. 开播遇 `60043`：面板用 `risk_extra.v_voucher` 生成官方人脸验证二维码，手机 B 站 App 扫码完成

## 本版变更

- 一键安装脚本随 Release 一起发布：`install.sh`（Linux/macOS）、`install.ps1`（Windows）
- 修复发布流水线未检出仓库、导致安装脚本打包失败的问题
- 完整安装矩阵与平台使用说明（含 iOS / 鸿蒙 / Android 的 USB 端口转发流程）
- 设置页「赞助与广告」、README 商业化章节（自 v0.1.2 起）
- 开播 `60043` 人脸验证二维码（`risk_extra.v_voucher`，自 v0.1.2 起）