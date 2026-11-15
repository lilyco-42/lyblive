# lyblive 图标资产

- favicon.svg：Web 控制台站点图标，同时由 web/src/components/Logo.tsx 在标题栏复用。
- icon-{16,32,48,64,128,256,512,1024}.png：方形品牌图标，按像素尺寸命名。
- icon-transparent-{256,512}.png：透明底备用图。
- icon.ico：Windows 多尺寸 ICO，包含 16/32/48/64/128/256 六种尺寸、32 位 PNG 载荷。
- icon.icns：macOS ICNS，包含 ic07/ic08/ic09/ic10 四种 PNG 类型；由 _mkicns.py 生成，格式为 b"icns" + 大端总长度 + chunk。
- android/：icon-256.png、icon-foreground-512.png、icon-playstore-512.png（文件实际为 1024x1024 供商店缩放使用）。

所有产物都未包含账号、Cookie 或签名密钥；应用二进制与 Release 资产保持未签名。
