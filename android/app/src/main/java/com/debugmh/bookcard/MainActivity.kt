package com.debugmh.bookcard

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var assetLoader: WebViewAssetLoader

    /**
     * 卡片图分片接收缓冲。
     * 1080 宽的卡片图 base64 常达 1–3MB，作为单个参数传给 JavascriptInterface 会被 IPC
     * 静默丢弃（不报错、不回调），表现为"点了分享没反应"。故统一按 64KB 分片推送。
     */
    private var imgName = "读书卡.png"
    private var imgParts: Array<ByteArray?> = emptyArray()
    private var imgGot = 0

    /** 最近一次系统栏尺寸（dp），页面加载完成后需补发一次 */
    private var insetTop = 0
    private var insetBottom = 0

    private val picker =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val uri: Uri? = if (res.resultCode == Activity.RESULT_OK) res.data?.data else null
            fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
            fileCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        // 背景色与网页纸白一致，避免冷启动瞬间闪一下系统白
        window.setBackgroundDrawable(ColorDrawable(PAPER_BG))
        setupEdgeToEdge()

        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.setBackgroundColor(Color.TRANSPARENT)

        // 便于在 chrome://inspect 上排查问题（仅 debug 包开启）
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage 必需，否则读书卡存不住
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            // 必须是 LOAD_DEFAULT：Tesseract 的 wasm 内核与中英文语言包合计约 30MB，
            // 关掉 HTTP 缓存会导致每次 OCR 都重新下载，首次识别慢到不可用。
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        web.webChromeClient = object : WebChromeClient() {

            /** OCR 选图 / 封面上传依赖系统文件选择器回调，缺了它按钮点了毫无反应 */
            override fun onShowFileChooser(
                view: WebView,
                cb: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback = cb
                return try {
                    picker.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    toast("无法打开图片选择器：${e.message}")
                    false
                }
            }

            /** 网页里的 alert() 必须由原生代弹，否则被静默吞掉——
             *  例如"请至少填写书名和摘录内容"将完全不显示，表现为点了保存没反应。 */
            override fun onJsAlert(
                view: WebView,
                url: String,
                message: String,
                result: JsResult
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("知道了") { _, _ -> result.confirm() }
                    .setCancelable(false)
                    .show()
                return true
            }

            /** confirm() 同理：不实现会恒返回 false，网页里的「确定导入吗」将永远被当成取消 */
            override fun onJsConfirm(
                view: WebView,
                url: String,
                message: String,
                result: JsResult
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setCancelable(false)
                    .show()
                return true
            }
        }

        web.addJavascriptInterface(Bridge(), "AndroidBridge")

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            /** 未被 AssetLoader 接管的链接（如 CDN）一律留在应用内，不跳系统浏览器 */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean = !request.url.toString().startsWith(BASE_URL)

            override fun onPageFinished(view: WebView, url: String) {
                pushInsets()
                applySystemBarIcons()
            }
        }

        // 硬件返回键：先交给网页消费（关弹窗 / 从子页面回到首页），否则退出
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript(
                    "(function(){return (window.__appBack && window.__appBack())?'1':'0'})()"
                ) { r ->
                    if (r?.trim('"') != "1") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

        web.loadUrl(BASE_URL + "assets/index.html")
        ViewCompat.requestApplyInsets(window.decorView)
    }

    /**
     * 边到边：内容延伸到状态栏与导航栏之下，消除全面屏上下的白边。
     * 白边是原生窗口层的产物，只改 CSS 无效。
     */
    private fun setupEdgeToEdge() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        // Android 10+ 会给透明导航栏自动加对比条纹，不关掉底部仍浮一条灰白
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        // 刘海 / 挖孔屏：允许内容铺到缺口两侧
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, ins ->
            val sys = ins.getInsets(WindowInsetsCompat.Type.systemBars())
            insetTop = pxToDp(sys.top)
            insetBottom = pxToDp(sys.bottom)
            pushInsets()
            ins
        }
        applySystemBarIcons()
    }

    private fun pxToDp(px: Int) = (px / resources.displayMetrics.density).roundToInt()

    /** env(safe-area-inset-*) 在 WebView 中常返回 0，故以原生实测值注入 CSS 变量为准 */
    private fun pushInsets() {
        if (!::web.isInitialized) return
        web.evaluateJavascript(
            "(function(){var r=document.documentElement;if(!r)return;" +
                "r.style.setProperty('--sat','$insetTop'+'px');" +
                "r.style.setProperty('--sab','$insetBottom'+'px');})()",
            null
        )
    }

    /** 页面为纸白底，需深色状态栏图标 */
    private fun applySystemBarIcons() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private fun toast(msg: String) =
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    @Suppress("unused")
    inner class Bridge {

        /**
         * 导出 JSON / TXT。
         * 网页里的 <a download> + blob: 在 WebView 中不会触发任何下载（无 DownloadListener 时
         * 静默丢弃），必须由原生落盘。零权限：Android 10+ 走 MediaStore，低版本走 App 专属目录。
         */
        @JavascriptInterface
        fun saveText(name: String, text: String) {
            val mime = when {
                name.endsWith(".json", true) -> "application/json"
                name.endsWith(".txt", true) -> "text/plain"
                else -> "text/plain"
            }
            writeFile(name, mime, text.toByteArray(Charsets.UTF_8))
                ?.let { toast("已导出到：$it") }
                ?: toast("导出失败")
        }

        /**
         * 分享摘录文本。
         * 网页侧的 navigator.share 在 WebView 中不存在，回退的 navigator.clipboard 又依赖
         * 安全上下文，原来两条路都可能静默失败，故改由原生拉起系统分享面板。
         */
        @JavascriptInterface
        fun shareText(title: String, text: String) {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                        if (title.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, title)
                    }
                    startActivity(Intent.createChooser(intent, title.ifBlank { "分享" }))
                } catch (e: ActivityNotFoundException) {
                    toast("没有可用的分享应用")
                } catch (e: Exception) {
                    toast("分享失败：${e.message}")
                }
            }
        }

        /* ---- 卡片图传输：必须分片，单次传整串 base64 会被 IPC 丢弃 ---- */

        @JavascriptInterface
        fun beginImage(name: String, total: Int) {
            imgName = name.ifBlank { "读书卡.png" }
            imgParts = arrayOfNulls(total)
            imgGot = 0
        }

        @JavascriptInterface
        fun pushImagePart(idx: Int, b64: String) {
            try {
                if (idx in imgParts.indices && imgParts[idx] == null) {
                    imgParts[idx] = Base64.decode(b64, Base64.DEFAULT)
                    imgGot++
                }
            } catch (e: Exception) {
                toast("图片第 ${idx + 1} 片接收失败：${e.message}")
            }
        }

        /** 保存卡片图到相册（Android 10+ 走 MediaStore 图片集，零权限） */
        @JavascriptInterface
        fun saveImageDone() {
            val bytes = assembleImage() ?: return
            writeFile(imgName, "image/png", bytes, picture = true)
                ?.let { toast("已保存到：$it") }
                ?: toast("保存失败")
        }

        /** 拉起系统分享面板，把卡片图发给微信 / 微博等平台 */
        @JavascriptInterface
        fun shareImageDone() {
            val bytes = assembleImage() ?: return
            val file = File(cacheDir, SHARE_DIR + "/" + imgName).apply {
                parentFile?.mkdirs()
                writeBytes(bytes)
            }
            shareFile(file, "image/png", "分享读书卡")
        }

        /** 让网页能把异常直接显示出来，避免只有 console 里才看得到 */
        @JavascriptInterface
        fun toast(msg: String) = this@MainActivity.toast(msg)
    }

    /** 拼装已收到的分片。缺片时给出明确提示——静默失败是最难排查的一类故障 */
    private fun assembleImage(): ByteArray? {
        if (imgParts.isEmpty() || imgGot != imgParts.size) {
            toast("图片接收不完整（$imgGot/${imgParts.size}），请重试")
            return null
        }
        return try {
            val out = java.io.ByteArrayOutputStream()
            imgParts.forEach { out.write(it!!) }
            out.toByteArray().also {
                imgParts = emptyArray()
                imgGot = 0
            }
        } catch (e: Exception) {
            toast("图片拼装失败：${e.message}")
            null
        }
    }

    /**
     * 通过 FileProvider 把私有文件分享给其他应用。
     * 零权限：不需要存储权限，也不要求文件位于公共目录。
     */
    private fun shareFile(file: File, mime: String, chooserTitle: String) {
        runOnUiThread {
            try {
                val uri = FileProvider.getUriForFile(this, AUTHORITY, file)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                // 逐个给候选应用授权，否则部分 App 拿到 content:// 后打不开
                packageManager.queryIntentActivities(intent, 0).forEach { ri ->
                    grantUriPermission(
                        ri.activityInfo.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                }
                startActivity(Intent.createChooser(intent, chooserTitle))
            } catch (e: ActivityNotFoundException) {
                toast("没有可用的分享应用")
            } catch (e: Exception) {
                toast("分享失败：${e.message}")
            }
        }
    }

    /**
     * 写文件。全程不使用任何存储权限：
     * - Android 10+ 走 MediaStore：「下载」集合，或图片集（picture=true 时）
     * - Android 8/9 走 App 专属外部目录（自 Android 4.4 起无需权限）
     * 刻意不用 getExternalStoragePublicDirectory：它需要 WRITE 权限，
     * 而本应用未申请任何存储权限，会在旧系统上静默失败。
     * @return 写入的目标路径，用于提示用户；失败返回 null
     */
    private fun writeFile(
        name: String,
        mime: String,
        data: ByteArray,
        picture: Boolean = false
    ): String? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        if (picture) Environment.DIRECTORY_PICTURES + "/" + PICTURES_DIR
                        else Environment.DIRECTORY_DOWNLOADS
                    )
                    // IS_PENDING：写完前对其他应用不可见，避免相册里出现半张图
                    if (picture) put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val collection =
                    if (picture) MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    else MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val uri = contentResolver.insert(collection, values)
                    ?: throw IOException("无法创建文件")
                contentResolver.openOutputStream(uri)?.use { it.write(data) }
                if (picture) {
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(uri, values, null, null)
                }
                if (picture) "图片/$PICTURES_DIR/$name" else "下载/$name"
            } else {
                val base = getExternalFilesDir(
                    if (picture) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS
                ) ?: filesDir
                val dir = if (picture) File(base, PICTURES_DIR) else base
                if (!dir.exists()) dir.mkdirs()
                File(dir, name).writeBytes(data)
                File(dir, name).absolutePath
            }
        } catch (e: Exception) {
            toast("保存失败：${e.message}")
            null
        }
    }

    companion object {
        /** 走 AssetLoader 的 HTTPS 源：file:// 源为 null，会让 OCR 的跨域请求全部失败 */
        private const val BASE_URL = "https://appassets.androidplatform.net/"
        private val PAPER_BG = 0xFFF4EFE6.toInt()

        /** FileProvider 授权标识，必须与 AndroidManifest 中的 authorities 一致 */
        private const val AUTHORITY = "com.debugmh.bookcard.fileprovider"

        /** 分享卡片图的缓存子目录，与 res/xml/file_paths.xml 的 path 对应 */
        private const val SHARE_DIR = "images"

        /** 保存到相册时的子目录名。刻意用英文：部分 ROM 对 MediaStore 的中文
         *  RELATIVE_PATH 处理不稳，可能出现文件写进去了但相册扫不到。 */
        private const val PICTURES_DIR = "BookCards"
    }
}
