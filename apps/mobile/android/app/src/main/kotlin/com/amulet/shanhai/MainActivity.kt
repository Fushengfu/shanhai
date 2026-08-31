package com.amulet.shanhai

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "shanhai/installer")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "installApk" -> {
                        val path = call.argument<String>("path")
                        if (path == null) {
                            result.error("BAD_ARG", "path is null", null)
                            return@setMethodCallHandler
                        }
                        try {
                            val apk = File(path)
                            // FileProvider.getUriForFile 生成 content:// URI（对应 res/xml/file_paths.xml 的
                            // external-files-path：/storage/emulated/0/Android/data/<pkg>/files/shanhai-update/）。
                            // 下载目录与 external-files-path 精确匹配，无 /data/data vs /data/user/0 符号链接
                            // 别名问题；PackageInstaller API 在华为 EMUI 上确认广播 status=-1 且 EXTRA_INTENT
                            // 为 null、无法弹确认界面（已弃用），故用 ACTION_VIEW 拉起系统安装器。
                            val uri: Uri = FileProvider.getUriForFile(
                                this,
                                "${packageName}.fileprovider",
                                apk
                            )
                            val intent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(uri, "application/vnd.android.package-archive")
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            // 拉起系统安装器（API 26+ 若未授权「允许安装未知应用」会先走系统授权引导）
                            startActivity(intent)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("INSTALL_FAILED", e.message ?: "install failed", null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
