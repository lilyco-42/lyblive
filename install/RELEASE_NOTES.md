## 一键安装

Linux / macOS:

```bash
curl -fsSL https://github.com/lilyco-42/lyblive/releases/latest/download/install.sh | sh
```

Windows (PowerShell，二选一):

```powershell
irm https://github.com/lilyco-42/lyblive/releases/latest/download/install.ps1 | iex
```

可选参数：`LYBLIVE_VERSION=v0.3.6` 指定版本；Linux/macOS 可用 `LYBLIVE_BIN_DIR` 指定安装目录；Linux 上加 `LYBLIVE_FLOAT=1` 会一并启用桌面悬浮弹幕层（写入 `lyblive-float.service` 并立即启动）。

## 资产

| 平台 | 文件 |
| --- | --- |
| Linux x86_64（含桌面悬浮层） | `lyblive-linux-x86_64` |
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
adb reverse tcp:8769 tcp:8769     # Android
iproxy 8769 8769                  # iOS (libimobiledevice)
hdc rport tcp:8769 tcp:8769       # 鸿蒙
```

手机浏览器打开 `http://127.0.0.1:8769/` 即可。端口转发只走 USB，不开放局域网端口，也不改变后端只监听 `127.0.0.1` 的安全策略。

## 使用

1. `lyblive --web` → 浏览器 `http://127.0.0.1:8769/` → 扫码登录 B 站
2. 「房间」改标题/分区/公告；「直播」开播、停播、复制推流地址与密钥（默认打码）
3. 服务启动后自动开始弹幕监控；「弹幕」页看头像、名字、礼物图标与数量、进场/关注/分享
4. 桌面常驻浮层（Linux）：`lyblive --float`，或安装时 `LYBLIVE_FLOAT=1` 交给 systemd user
5. OBS 集成：退出 OBS 后 `lyblive --obs-install`，重开即出现 lyblive 面板
6. 开播遇 `60043`：面板用 `risk_extra.v_voucher` 生成官方人脸验证二维码，手机 B 站 App 扫码完成

## 本版变更（0.3.8）

- 弹幕监控：页面打开时若处于「已停止」状态，会**自动恢复一次**，不再出现「打开面板没弹幕、还漏进场」的情况
- README 明确：桌面悬浮层**仅 Linux**（托盘基于 D-Bus）；Windows / macOS 使用 `/overlay`（OBS 浏览器源或浏览器窗口）

## 0.3.7

- 「房间 → 修改分区」与「直播 → 开播分区」改为**可搜索下拉**：输入关键字即时过滤，显示 `匹配数 / 总数`；一级、二级分区都支持，选中项带勾选标记
- 分区很多时不再需要滚动找选项；回车可选中第一条匹配项，Esc 关闭

## 0.3.6

- 新增 Linux 桌面常驻形态：`--float` 无边框/透明/置顶浮层 + StatusNotifierItem 托盘；默认鼠标穿透，托盘可切换；`lyblive-float.service` 可后台常驻
- 弹幕消息补发送者头像与名字，前端列表与之同步
- 礼物消息显示图标、名称与数量（数量回退 `num → batch_combo_num → combo_num`）
- 修正 `INTERACT_WORD_V2`：解码 `data.pb`（base64 protobuf）里的用户名、消息类型与头像，不再一律显示「互动」
- 修正改标题「不生效」：直播间信息改用实时的 `getInfoByRoom`，写接口改用 `platform=web`
- 服务启动后自动开始弹幕监控；服务重启后前端按 `startedAt` 清理旧消息
- Linux 预编译资产改为带 `desktop` feature 构建，一键安装可直接使用 `--float`