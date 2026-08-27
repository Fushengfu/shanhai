import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/update_service.dart';

/// 版本更新提示弹窗：显示新版本号、更新说明，提供「下载更新」与「稍后再说」。
/// forceUpdate 时只有「下载更新」，不允许忽略。
Future<void> showUpdateDialog(BuildContext context, UpdateInfo update) async {
  await showDialog<void>(
    context: context,
    barrierDismissible: !update.forceUpdate,
    builder: (ctx) {
      return AlertDialog(
        backgroundColor: const Color(0xFF1C1C28),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            const Icon(Icons.system_update_alt, color: Color(0xFF8B5CF6), size: 22),
            const SizedBox(width: 8),
            const Expanded(
              child: Text(
                '发现新版本',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Colors.white),
              ),
            ),
            if (update.forceUpdate)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF7C2D2D),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: const Text('强制更新', style: TextStyle(fontSize: 11, color: Color(0xFFFCA5A5))),
              ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '新版本 v${update.version}',
              style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0), fontWeight: FontWeight.w600),
            ),
            if (update.releaseNotes != null && update.releaseNotes!.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('更新内容：', style: TextStyle(fontSize: 13, color: Color(0xFFA0A0A0))),
              const SizedBox(height: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 180),
                child: SingleChildScrollView(
                  child: Text(
                    update.releaseNotes!,
                    style: const TextStyle(fontSize: 13, color: Color(0xFFC0C0C0), height: 1.5),
                  ),
                ),
              ),
            ],
          ],
        ),
        actions: [
          if (!update.forceUpdate)
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('稍后再说', style: TextStyle(fontSize: 13, color: Color(0xFF9CA3AF))),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF8B5CF6)),
            onPressed: () async {
              await _openDownload(update.downloadUrl);
              if (ctx.mounted) Navigator.of(ctx).pop();
            },
            child: const Text('下载更新', style: TextStyle(fontSize: 13, color: Colors.white)),
          ),
        ],
      );
    },
  );
}

/// 打开 APK 下载链接（跳系统浏览器下载，下载完成后用户手动点击安装）。
Future<void> _openDownload(String url) async {
  final uri = Uri.parse(url);
  try {
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok) {
      throw Exception('无法打开链接');
    }
  } catch (_) {
    // 兜底：仍尝试用外部浏览器打开，失败则静默（避免打断用户）
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // ignore
    }
  }
}
