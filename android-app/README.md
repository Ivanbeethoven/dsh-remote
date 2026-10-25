# DSH Bridge（Android）

一个 WebView 壳，专门用来从手机打开你自己那台 DSH。整个工程只有一个 Activity、没有任何
AndroidX 依赖。

## 它解决什么问题

DSH 的 launch token 每次重启都会变，所以**不能**把它打进 App。能固定下来的只有中继的访问密钥。
于是 App 每次冷启动都这样做：

```
1. GET  /ssh-bridge?rk=<ACCESS_KEY>&go=1   ← 中继设 Cookie，插件看到 go 就 302 到当前配对链接
2. GET  <当前 token 链接>                   ← DSH 设 Cookie，再 303 到 ./
3. GET  /                                   ← DSH 界面
```

全程是**普通 HTTP 重定向**，不依赖 WebView 里注入 JS、也不读 DOM。所以 token 轮换、DSH 重启都不需要
重新打包 App。App 里只有两个固定值：中继地址和访问密钥。

`go=1` 是关键：没有它，插件会渲染状态页（就是那个显示二维码和链接的页面）；有它，插件直接 302。

## 构建

需要 JDK 17 与 Android SDK（Android Studio 自带）。

**用 Android Studio（最省事）**

1. `File → Open` 选这个目录；
2. 首次会提示安装 SDK / 生成 Gradle wrapper，照做；
3. 连手机或开模拟器，点 Run。

**命令行**

```bash
cd android-app
gradle wrapper --gradle-version 8.7     # 只需一次，生成 ./gradlew
./gradlew assembleDebug                 # 产物：app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 打自己的包之前要改的三个值

都在 `app/build.gradle.kts` 的 `defaultConfig` 里：

| 字段 | 含义 | 仓库里的占位值 |
|---|---|---|
| `RELAY_BASE` | 中继的公网地址 | `https://relay.example.com:8443` |
| `ACCESS_KEY` | 中继访问密钥（插件里的 `relay.accessToken`） | `REPLACE_WITH_YOUR_ACCESS_KEY` |
| `RELAY_CERT_SHA256` | 中继证书的 SHA-256 指纹 | `REPLACE_WITH_RELAY_CERT_SHA256` |

> 仓库里的 `res/raw/relay_cert.pem` 是一张 **示例自签证书**（CN=localhost），只为让工程能直接编译。
> 换成你自己中继的证书，否则连不上。

指纹在服务器上这样取：

```bash
openssl x509 -in /opt/dsh-relay/data/cert.pem -noout -fingerprint -sha256
```

**证书换了指纹就会变**（比如重装了中继）。那时 App 会拒绝连接——这是刻意的：宁可打不开，也不
接受一张被替换的证书。重算指纹、重新打包即可。

## TLS

中继用的是自签证书。**不能**只靠 `onReceivedSslError` 放行——那个回调只对 WebView 的导航/子资源
生效，DSH 客户端打开的 **WebSocket 在渲染进程里自己握手，根本不会走它**，于是页面 HTML 能加载、
WS 却连不上，表现就是白屏。

所以 App 把中继证书作为**额外信任锚**打进包里：

- `res/raw/relay_cert.pem` —— 中继的证书
- `res/xml/network_security_config.xml` —— 在系统信任库之外加上这张证书

这样 HTTP 和 WebSocket 都走正常校验，不是绕过。`RELAY_CERT_SHA256` 仍然保留，作为锚点万一没生效时的
第二道检查。

> **证书轮换时**：中继重新生成证书后，必须同时替换 `res/raw/relay_cert.pem` **和** `RELAY_CERT_SHA256`
> 再重新打包，否则 App 会（按设计）拒绝连接。
>
> 取证书：`openssl x509 -in /opt/dsh-relay/data/cert.pem -outform PEM`
> 取指纹：`openssl x509 -in /opt/dsh-relay/data/cert.pem -noout -fingerprint -sha256`

加载失败时不再白屏：`onReceivedError` / `onReceivedHttpError` 会渲染一个深色错误页，显示错误码、
失败 URL 和「重试」链接。

## 安全提醒

- **这个 APK 就是一把钥匙。** 谁拿到它，谁就能连你的 DSH（因为访问密钥在里面，而 App 又能自己
  取到 token）。不要分发，不要放到公开网盘。
- 密钥泄露了就改 `accessToken` 并重启中继：`/opt/dsh-relay/data/secrets.env` 里改完后
  `systemctl restart dsh-relay`，然后重新打包 App。
- 想再加一层：给安全组 8443 加 IP 白名单，或者给中继换个不常用的端口。

## 外观

| | |
|---|---|
| 桌面名称 | `DSH`（改 `app/src/main/res/values/strings.xml` 的 `app_name`） |
| 图标 | 自适应矢量图标，无需位图：`drawable/ic_launcher_background.xml` + `ic_launcher_foreground.xml`，由 `mipmap-anydpi-v26/ic_launcher.xml` 组合 |
| 主题 | 深色无标题栏 + `windowBackground` 同底色，避免启动白闪 |
| 启动画面 | Android 12+ 使用同色底 + 图标前景（`values-v31/themes.xml`） |

图标是「终端提示符」`>_`：深海军蓝底 + 一条斜向色带，前景用 `#38BDF8` 的折角和 `#E2E8F0` 的下划线。
所有元素都落在 66dp 安全区内，圆形、方形、水滴各种遮罩都不会切到内容。

改配色只改 `values/colors.xml`；换图形只改 `ic_launcher_foreground.xml` 里的 `pathData`。

预览脚本（需要 `sharp`）：`node ../tools/preview-icon.mjs`，会按 Android 的裁切规则渲染圆/方两种遮罩
以及 48dp 抽屉尺寸。

## 已知限制

- 界面是 **DSH 官方的 Web GUI**，桌面导向，没有做触屏重排（那是 dsh-mobile 那种客户端插件的
  工作）。手机上能用，但不是原生手感。
- 只有一个 WebView，没有推送通知、没有多电脑切换。
