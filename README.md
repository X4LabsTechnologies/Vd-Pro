# Vd-Pro v4.5.0

محرك عام لاكتشاف واستخراج وسائط الفيديو من صفحات الويب باستخدام Node.js وPlaywright. يدعم اكتشاف روابط HLS وDASH وMP4 وWebM، وتحليل الجودات والترجمات، ومراقبة طلبات الشبكة، وفحص DOM وJavaScript وiframes، مع الحفاظ على واجهات API الحالية وعدم إضافة منطق خاص بموقع معيّن.

> **مهم:** يعمل المحرك مع الوسائط التي يكشفها الموقع أو المشغل للمتصفح. قد تكون بعض الروابط موقعة ومؤقتة وتتطلب Referer أو سياق جلسة.

## الحالة الحالية

| العنصر | الحالة |
|---|---|
| الإصدار | `4.5.0` |
| نقطة التشغيل | `server.js` |
| قاعدة البيانات | MongoDB اختيارية للتشغيل الأساسي، ومستخدمة للمستخدمين والحفظ عند ضبطها |
| الطابور | Bull فوق Redis |
| المتصفح | Playwright Chromium |
| المصادقة | JWT عبر `Authorization: Bearer TOKEN` |
| البحث | DuckDuckGo API وDuckDuckGo HTML وBing وWikipedia، مع TMDB وOMDb اختياريًا |
| التخزين المؤقت | ذاكرة العملية، Redis، وMongoDB عند توفرها |
| الاختبارات | فحص صياغة Node وفحص الفرق واختبارات MediaFlow المحلية متاحة |

## وحدة الاستخراج الاحتياطية

يوجد مسار احتياطي مستقل في `src/fallback-extractor.js`. يستخدمه الخادم تلقائيًا عند فشل الاستخراج الأساسي أو عدم الحصول على رابط قابل للاستخدام، ويعيد نفس الحقول الأساسية للرابط والجودات والترجمات مع معلومات تشخيصية إضافية داخل `diagnostics`. الوحدة عامة ولا تحتوي على تكاملات أو قواعد خاصة بموقع محدد، ولا تغيّر مسارات API الحالية.

يتم تشغيل المسار الاحتياطي داخل عامل المهمة وبنفس سياق الخدمة، وليس كمنفذ HTTP ثانٍ؛ وهذا يمنع تعارض المنافذ ويضمن أن الطابور والمصادقة والتخزين تبقى موحّدة. عند نجاح المسار الأساسي لا يتم تشغيل الوحدة الاحتياطية، وعند فشلها تُحفظ نتيجة المسار الأساسي مع `fallbackAttempted` وسبب الفشل للمراجعة.

## المتطلبات والتشغيل المحلي

يتطلب المشروع Node.js 18 أو أحدث. يتطلب Redis وMongoDB عند استخدام الطوابير والتسجيل والتخزين الدائم. ثبّت الاعتمادات ثم شغّل الخادم:

```bash
npm install
npm start
```

للتطوير:

```bash
npm run dev
```

للتشغيل الإنتاجي:

```bash
npm run prod
```

يستمع الخادم افتراضيًا على المنفذ `3000`، أو على المنفذ المحدد في المتغير `PORT`.

## إعداد البيئة

انسخ `.env.example` إلى `.env` واملأ القيم المناسبة. في بيئة الإنتاج يجب أن يكون `JWT_SECRET` موجودًا وطوله 32 حرفًا على الأقل.

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=ضع_سرًا_عشوائيًا_طويلًا_هنا
MONGODB_URL=mongodb+srv://USER:PASSWORD@HOST/vd-pro
REDIS_URL=redis://default:PASSWORD@HOST:PORT
```

### الإعدادات الاختيارية

| المتغير | الافتراضي | الاستخدام |
|---|---:|---|
| `TMDB_API_KEY` | فارغ | تحسين البحث عبر TMDB |
| `OMDB_API_KEY` | فارغ | إضافة نتائج IMDb/OMDb إلى البحث بالاسم |
| `PROXIES` | فارغ | قائمة بروكسيات مفصولة بفواصل |
| `PROXY_URL` | فارغ | بروكسي عام واحد بصيغة URL |
| `VD_PROXY_URL` | فارغ | اسم بديل لبروكسي واحد |
| `VD_PROXY_URLS` | فارغ | اسم بديل لقائمة بروكسيات المتصفح |
| `MEDIAFLOW_PROXY_URL` | عنوان MediaFlow المرفق | نقطة MediaFlow لإعادة توجيه HLS |
| `MEDIAFLOW_PROXY_PASSWORD` | فارغ | كلمة مرور MediaFlow؛ عند غيابها يبقى الرابط الخام |
| `MEDIAFLOW_USER_AGENT` | User-Agent افتراضي | User-Agent المرسل إلى MediaFlow |
| `BROWSER_POOL_COUNT` | `1` | عدد عمليات Chromium |
| `BROWSER_CONTEXTS_PER_POOL` | `2` | عدد سياقات المتصفح لكل عملية |
| `HARD_EXTRACT_MS` | `110000` | الحد الأقصى لعملية الاستخراج بالميلي ثانية |
| `JOB_PROCESS_TIMEOUT_MS` | محسوب تلقائيًا | المهلة الخارجية للمهمة؛ يمكن ضبطها من Render |
| `HARD_SEARCH_MS` | `30000` | الحد الأقصى للبحث بالميلي ثانية |
| `NAV_TIMEOUT_MS` | `45000` | مهلة فتح الصفحة بالميلي ثانية |
| `MEDIA_IDLE_WAIT_MS` | `8000` | مدة انتظار استقرار طلبات الوسائط بعد التفاعل |
| `WATCHDOG_INTERVAL_MS` | `15000` | فترة مراقبة المهام العالقة |
| `ALLOWED_ORIGINS` | فارغ | نطاقات CORS مفصولة بفواصل |
| `LOG_LEVEL` | `info` | مستوى سجل التشغيل |

مثال للإعدادات الاختيارية:

```env
TMDB_API_KEY=your_tmdb_api_key
OMDB_API_KEY=your_omdb_api_key
PROXY_URL=http://user:pass@host:port
BROWSER_POOL_COUNT=1
BROWSER_CONTEXTS_PER_POOL=2
```

لا يضيف ضبط بروكسي المتصفح أي تجاوز للحماية؛ هو مسار اختياري لتوجيه جلسة المتصفح عندما تكون قيمة صالحة متاحة. لا تضع الأسرار داخل المستودع.

### ربط MediaFlow HLS

يمكن لـ Vd-Pro، بشكل اختياري، إعادة توجيه روابط HLS المكتشفة عبر MediaFlow. لا يُرسل الخادم أي طلب إلى MediaFlow أثناء التشغيل إذا لم تضبط كلمة المرور. عند التفعيل، تُحوّل `primaryUrl` وروابط `urls.m3u8` وروابط HLS داخل `variants` إلى المسار العام التالي، مع ترميز الرابط الخام وكلمة المرور والرؤوس:

```env
MEDIAFLOW_PROXY_URL=https://mediaflow-proxy-light-37xr.onrender.com
MEDIAFLOW_PROXY_PASSWORD=كلمة_المرور_الفعلية
MEDIAFLOW_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
```

يُرسل `h_referer` من سياق الرابط المكتشف، ويُرسل `h_user-agent` من الإعداد أعلاه. عند توفر أكثر من بروكسي، يمكن للمحرك تبديل البروكسي وإعادة محاولة واحدة داخل ميزانية المهمة عند غياب الوسائط أو فشل التحقق، وتظهر النتيجة في `diagnostics.proxyUsed` و`proxySwitched` و`proxyErrors`. ويتحقق محرك MP4 من استجابة Range الثنائية، وتوقيع `ftyp` عند توفره، ونوع المحتوى، مع رفض HTML/JSON والحالات HTTP غير الصالحة بدل قبول أي رابط يحمل امتداد `.mp4`. تُحفظ قيمة الرابط الخام في `linkMeta.originalUrl`، ويُوضع رابط MediaFlow في `linkMeta.proxyUrl`، بينما تبقى روابط MP4 وWebM وDASH دون إعادة توجيه لأن إعداد MediaFlow الموصوف هنا خاص بمسار HLS. لا يتم اختبار خادم MediaFlow تلقائيًا؛ تظهر حالة التفعيل فقط في health عبر `mediaFlow.configured`.

## تشغيل Render

يمكن تشغيل المشروع كـ Web Service على Render باستخدام:

```text
Build Command: npm install
Start Command: npm start
```

يستمع التطبيق على `0.0.0.0` ويستخدم متغير `PORT` الذي يوفره Render. يبدأ HTTP مبكرًا أثناء تجهيز MongoDB وChromium في الخلفية، لذلك يمكن لنقطة الصحة الاستجابة أثناء cold start. تكون الخدمة جاهزة للاستخراج عندما يكون الحقل `ready` مساويًا لـ `true`.

اضبط المتغيرات التالية في Render:

```env
JWT_SECRET=سر_إنتاجي_طويل
MONGODB_URL=رابط_MongoDB
REDIS_URL=رابط_Redis
```

يمكن ضبط `TMDB_API_KEY` و`OMDB_API_KEY` و`PROXIES` اختياريًا. إذا لم يتم ضبط OMDb أو البروكسيات فسيظهر ذلك في نقطة الصحة، مع استمرار عمل بقية الوظائف.

## نقاط API الحالية

جميع النقاط التالية، باستثناء health وregister، تحتاج إلى رأس المصادقة:

```http
Authorization: Bearer YOUR_TOKEN
```

### فحص الصحة

```http
GET /api/v1/health
```

لا تتطلب هذه النقطة مصادقة. تعيد حالة MongoDB وRedis، الإصدار، الجاهزية، المهلات، موفري البحث، وحالة إعداد البروكسي.

مثال:

```json
{
  "status": "healthy",
  "ready": true,
  "name": "Vd-Pro",
  "version": "4.5.0",
  "redis": "ready",
  "mongodb": "connected",
  "searchProviders": {
    "ddgApi": true,
    "wikipedia": true,
    "tmdb": false,
    "omdbImdb": false
  },
  "proxy": {
    "configured": false,
    "count": 0
  }
}
```

أثناء cold start قد تكون قيمة `ready` مساوية لـ `false` مع بقاء HTTP متاحًا. يجب الانتظار حتى تصبح `ready: true` قبل إرسال مهام استخراج جديدة.

### تسجيل مستخدم

```http
POST /api/v1/auth/register
Content-Type: application/json
```

الطلب:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

يعيد الطلب `apiKey` و`token` و`plan` عند نجاح التسجيل. يجب أن تكون كلمة المرور بطول 8 أحرف على الأقل.

### استخراج فيديو من رابط صفحة

```http
GET /api/v1/extract?url=PAGE_URL&quality=auto&deep=true
Authorization: Bearer YOUR_TOKEN
```

المعاملات هي `url`، و`quality` مثل `auto` أو `1080p` أو `720p`، و`deep=true` لتفعيل جولات أعمق من التفاعل والفحص. يعيد الطلب مهمة غير متزامنة:

```json
{
  "success": true,
  "jobId": "JOB_ID",
  "statusUrl": "/api/v1/jobs/JOB_ID"
}
```

### البحث بالاسم

```http
GET /api/v1/search?q=اسم%20الفيلم&extract=false&quality=auto&deep=false
Authorization: Bearer YOUR_TOKEN
```

بدون `extract=true` يعيد البحث النتائج ويفصل بين `watchCandidates` و`infoCandidates`. عند استخدام `extract=true` يحاول استخراج الوسائط من أفضل مرشح مشاهدة ويضع النتيجة داخل `extraction`.

### متابعة المهمة

```http
GET /api/v1/jobs/JOB_ID
Authorization: Bearer YOUR_TOKEN
```

قد تكون الحالة `waiting` أو `active` أو `completed` أو `failed`. عند اكتمال المهمة توجد النتيجة داخل `result`. إذا تعذر الوصول إلى Redis تعيد النقطة خطأ واضحًا مثل `QUEUE_UNAVAILABLE` بدل تعليق الطلب بلا نهاية.

### حالة البروكسيات

```http
GET /api/v1/proxy-status
Authorization: Bearer YOUR_TOKEN
```

تعيد هذه النقطة حالة البروكسيات وعدد النجاحات والإخفاقات، مع إخفاء اسم المستخدم وكلمة المرور من العناوين المعروضة.

## أمثلة الاستخدام

### التسجيل والحصول على token

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

### بدء الاستخراج

```bash
curl "http://localhost:3000/api/v1/extract?url=https%3A%2F%2Fexample.com%2Fvideo&quality=auto&deep=true" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### البحث بالاسم

```bash
curl "http://localhost:3000/api/v1/search?q=Breaking%20Bad&extract=false" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### متابعة المهمة

```bash
curl "http://localhost:3000/api/v1/jobs/JOB_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## شكل نتيجة الاستخراج

تحافظ نتيجة الاستخراج على الحقول العامة التالية:

| الحقل | الوصف |
|---|---|
| `success` | يساوي `true` عندما يوجد مرشح صالح تم التحقق منه |
| `primaryUrl` | الرابط الأساسي المختار بعد ترتيب المرشحين والتحقق منهم |
| `urls` | الروابط المصنفة إلى `m3u8` و`mp4` و`webm` و`mpd` و`segment` و`other` |
| `variants` | نسخ الفيديو والجودات ومعدل النقل والدقة ونوع الوسيط وحالة التحقق |
| `subtitles` | روابط الترجمات المكتشفة من HLS وDASH وHTML وطلبات الشبكة |
| `qualities` | قائمة تسميات الجودات المكتشفة |
| `validated` | يوضح هل تم التحقق من الرابط الأساسي |
| `linkMeta` | معلومات Referer وTTL والتوقيع المحتمل للرابط |
| `diagnostics` | معلومات مثل عدد الطلبات والإطارات وحالة المشغل والصفحة |
| `errorCode` | رمز واضح عند عدم نجاح الاستخراج |

يدعم المحرك اكتشاف HLS وDASH، بما في ذلك manifests ونسخ الدقة والترجمات، كما يلتقط روابط الوسائط من HTML وJavaScript وتهيئات المشغلات وطلبات XHR/fetch وiframes المتداخلة وShadow DOM عندما يسمح المتصفح بذلك.

## آلية الاستخراج

يعمل المحرك بطريقة عامة متعددة المراحل. يبدأ بفتح الصفحة ومراقبة طلبات واستجابات الشبكة، ثم يحاول تشغيل عناصر HTML5 وتفعيل الإطارات الكسولة والنقر على أزرار التشغيل وعلامات اختيار السيرفر. بعد ذلك يفحص DOM وخصائص `data-*` وتهيئات المشغلات وملفات JSON وJavaScript والإطارات المتداخلة. تُحلل manifests المكتشفة لاستخراج الجودات والترجمات، ثم تُرتب المرشحات وتُفحص مع الحفاظ على Referer وسياق الطلب عندما يكون ذلك متاحًا.

يتضمن التحقق رفض روابط الإعلانات والمقاطع الوهمية والـ segments، ورفض ردود HTML التي تتظاهر بأنها ملفات MP4، والتحقق من بنية HLS وDASH، وتمييز الوسائط المشفرة أو المحمية.

## رموز الأخطاء المهمة

| الرمز | المعنى |
|---|---|
| `MISSING_URL` | لم يتم إرسال رابط صفحة |
| `INVALID_URL` | الرابط غير صالح أو مرفوض بسبب حماية SSRF |
| `QUEUE_ADD_TIMEOUT` | تعذر إضافة المهمة ضمن المهلة |
| `QUEUE_UNAVAILABLE` | Redis أو الطابور غير متاح أثناء قراءة الحالة |
| `EXTRACTION_TIMEOUT` | تجاوز الاستخراج الحد الزمني المحدد |
| `NO_STREAM_FOUND` | انتهى الفحص دون العثور على رابط فيديو |
| `NO_WATCH_CANDIDATE` | البحث أعاد صفحات معلوماتية فقط دون صفحة مشاهدة |
| `BOT_PROTECTION_SUSPECTED` | ظهرت مؤشرات حماية روبوت أو تحدٍ تفاعلي |
| `PROTECTED_MEDIA` | اكتُشفت وسائط محمية ولا يمكن التحقق من رابط عام لها |
| `CLOSED_PLAYER_OR_BLOB_ONLY` | اكتُشفت Pipeline مثل MSE دون رابط عام مكشوف |
| `STREAM_FOUND_BUT_UNPLAYABLE` | وُجدت مرشحات لكن لم ينجح التحقق من قابلية التشغيل |
| `TOKEN_EXPIRED_OR_SHORT_LIVED` | الرابط الموقع منتهي أو قصير العمر جدًا |
| `BROWSER_STARTING` | المتصفح ما زال في مرحلة الإقلاع؛ أعد المحاولة بعد الجاهزية |

## التخزين المؤقت والجلسات

يستخدم المشروع كاشًا متعدد المستويات عند توفر مكوناته. تُحفظ النتائج مؤقتًا في ذاكرة العملية، ويمكن استخدام Redis وMongoDB للبيانات المشتركة والدائمة. تُحفظ Cookies الخاصة بجلسة المستخدم في Redis لفترة محدودة عند توفر Redis. الروابط الموقعة قصيرة العمر لا تُخزن كاشًا عندما تكون مدة صلاحيتها قصيرة.

## الأمان والقيود

يستخدم المشروع JWT وbcrypt للمصادقة، وHelmet وCORS وrate limiting لحماية HTTP، وSSRF validation لمنع الوصول إلى عناوين خاصة، وفلترة للروابط غير المرغوبة. يجب تشغيل الخدمة خلف HTTPS في الإنتاج، وتغيير `JWT_SECRET`، وعدم مشاركة التوكنات أو مفاتيح OMDb وTMDB أو بيانات Redis وMongoDB.

لا يهدف المشروع إلى تجاوز أنظمة الحماية أو تسجيل الدخول غير المصرح به. إذا كان الموقع لا يكشف رابط الوسائط إلا بعد تحدٍ تفاعلي أو داخل نظام محمي، فسيعيد المحرك رمزًا تشخيصيًا بدل الادعاء بنجاح زائف.

## الاختبارات والتحقق

الفحوص المتاحة حاليًا:

```bash
node --check server.js
git diff --check
```

قبل النشر يجب تنفيذ فحص الصياغة وفحص الفرق واختبار نقطة الصحة، ثم تجربة صفحة محتوى عامة أو مصرح بها.

## Swagger

تتوفر واجهة Swagger الحالية على:

```text
/api-docs
```

استخدمها لاكتشاف تعريفات الواجهات المنشورة في النسخة الحالية، مع الاعتماد على مسارات API المذكورة أعلاه باعتبارها المسارات الفعلية في الخادم.

## الترخيص

MIT License.

آخر تحديث للتوثيق: 2026-08-24.

صيانة المشروع: Vd-Pro Team.
