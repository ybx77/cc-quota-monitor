# 把应用图标放在这里

想用自己的 logo 作为窗口 / 任务栏 / 打包图标：

1. 把图片命名为 `logo.png` 放进本目录（推荐 512×512 或更大、正方形、透明底）；
2. 运行：

```bash
npm run icons
```

脚本会生成：

| 文件 | 用途 |
| --- | --- |
| `build/icon.png` | 256×256，窗口 / Linux 图标 |
| `build/icon-512.png` | 512×512，商店 / macOS |
| `build/icon.ico` | 16~256 多尺寸，Windows 打包 |
| `build/icon-32.png` | 32×32，任务栏小图标 |
| `build/tray-preview/*.png` | 托盘图标预览（托盘图标是运行时按剩余额度动态绘制的，不需要替换） |

没有放 logo 时，脚本会使用内置的进度环图形，仓库依然可以正常构建。

> 支持的格式：PNG（8 位、非隔行，colorType 0/2/3/4/6）。JPEG/WebP 请先转成 PNG。
