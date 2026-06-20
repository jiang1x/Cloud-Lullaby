云端绘本：科大讯飞语音听写版

重要：
1. 不要把 APPID / APIKey / APISecret 写进 index.html。
2. 不要把密钥写进 GitHub 仓库。
3. 只在 Vercel 的 Environment Variables 里填写密钥。

Vercel 环境变量：
XFYUN_APPID=你的讯飞 APPID
XFYUN_API_KEY=你的讯飞 APIKey
XFYUN_API_SECRET=你的讯飞 APISecret

可选环境变量：
ALLOWED_ORIGIN=https://你的域名.vercel.app

部署后先访问：
https://你的域名/api/transcribe

如果显示：
configured: true
说明 api/transcribe.js 已部署，讯飞密钥也配置好了。

如果显示：
configured: false
说明 Vercel 环境变量没配好，或配完后没有重新 Deploy。

如果是 404：
说明 api/transcribe.js 没有进仓库，或者目录结构不对。

目录结构必须是：
index.html
img1.png
img2.png
img3.png
package.json
api/transcribe.js

注意：
这版前端会在浏览器中把麦克风音频转成 16kHz、16bit、单声道 PCM，
再发给 /api/transcribe。后端再通过科大讯飞语音听写 WebSocket 接口识别。
