import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import '../services/update_service.dart';

/// 升级弹窗阶段：信息展示 → 应用内下载（进度）→ SHA-256 完整性校验 → 拉起系统安装器 / 失败重试。
enum _UpdatePhase { info, downloading, verifying, error }

/// 版本更新提示弹窗：显示新版本号、更新说明，提供「下载更新」与「稍后再说」。
/// 点击「下载更新」后进入应用内完整升级：流式下载（实时进度）→ SHA-256 校验 → 系统安装器。
/// forceUpdate 时下载完成前不可关闭弹窗、无「稍后再说」。
Future<void> showUpdateDialog(BuildContext context, UpdateInfo update) async {
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => _UpdateDialog(update: update),
  );
}

class _UpdateDialog extends StatefulWidget {
  final UpdateInfo update;
  const _UpdateDialog({required this.update});

  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  _UpdatePhase _phase = _UpdatePhase.info;
  DownloadProgress _progress = const DownloadProgress(received: 0, total: -1);
  String _error = '';

  Future<void> _startDownload() async {
    setState(() {
      _phase = _UpdatePhase.downloading;
      _error = '';
      _progress = const DownloadProgress(received: 0, total: -1);
    });
    try {
      // 下载目录：Android 用「应用外部私有目录」getExternalFilesDir(null)
      // （/storage/emulated/0/Android/data/<pkg>/files/shanhai-update/），与 file_paths.xml 的
      // external-files-path 精确匹配——无 /data/data vs /data/user/0 符号链接别名问题，
      // FileProvider 生成 content:// URI 拉起系统安装器（PackageInstaller 在华为 EMUI 上
      // 确认广播 status=-1 且 EXTRA_INTENT=null，无法弹确认界面，已弃用）。
      final baseDir = Platform.isAndroid
          ? (await getExternalStorageDirectory())?.path ?? Directory.systemTemp.path
          : Directory.systemTemp.path;
      final dir = Directory('$baseDir/shanhai-update');
      await dir.create(recursive: true);
      final target =
          '${dir.path}/shanhai-v${widget.update.version}-${widget.update.versionCode ?? 0}.apk';
      final existing = File(target);
      if (existing.existsSync()) {
        try { existing.deleteSync(); } catch (_) {}
      }

      final file = await UpdateService().downloadApk(
        url: widget.update.downloadUrl,
        targetPath: target,
        onProgress: (p) {
          if (mounted) setState(() => _progress = p);
        },
      );
      if (!mounted) return;
      setState(() => _phase = _UpdatePhase.verifying);

      // SHA-256 完整性校验：网关 hash 字段为空视为「未配置校验值」，宁缺毋滥，不进入安装。
      final expected = widget.update.sha256;
      if (expected == null || expected.isEmpty) {
        try { file.deleteSync(); } catch (_) {}
        setState(() {
          _phase = _UpdatePhase.error;
          _error = '网关未下发更新包校验值（SHA-256），已中止安装，请稍后重试或联系运营';
        });
        return;
      }
      final ok = await UpdateService().verifyApkSha256(file, expected);
      if (!mounted) return;
      if (!ok) {
        try { file.deleteSync(); } catch (_) {}
        setState(() {
          _phase = _UpdatePhase.error;
          _error = '下载包完整性校验失败（SHA-256 不匹配），已删除文件，请重新下载';
        });
        return;
      }

      // 校验通过 → 拉起系统安装器（FileProvider content:// URI + ACTION_VIEW）
      await UpdateService().installApk(file);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _UpdatePhase.error;
        _error = '下载失败：$e';
      });
    }
  }

  void _close() => Navigator.of(context).pop();

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _phase == _UpdatePhase.info && !widget.update.forceUpdate,
      child: AlertDialog(
        backgroundColor: const Color(0xFF1C1C28),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: _buildTitle(),
        content: _buildContent(),
        actions: _buildActions(),
      ),
    );
  }

  Widget _buildTitle() {
    final (icon, text) = switch (_phase) {
      _UpdatePhase.info => (Icons.system_update_alt, '发现新版本'),
      _UpdatePhase.downloading => (Icons.downloading, '正在下载更新…'),
      _UpdatePhase.verifying => (Icons.verified_user_outlined, '正在校验完整性…'),
      _UpdatePhase.error => (Icons.error_outline, '更新失败'),
    };
    return Row(
      children: [
        Icon(icon, color: const Color(0xFF8B5CF6), size: 22),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Colors.white),
          ),
        ),
        if (widget.update.forceUpdate)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: const Color(0xFF7C2D2D),
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Text('强制更新', style: TextStyle(fontSize: 11, color: Color(0xFFFCA5A5))),
          ),
      ],
    );
  }

  Widget _buildContent() {
    switch (_phase) {
      case _UpdatePhase.info:
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '新版本 v${widget.update.version}',
              style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0), fontWeight: FontWeight.w600),
            ),
            if (widget.update.releaseNotes != null && widget.update.releaseNotes!.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('更新内容：', style: TextStyle(fontSize: 13, color: Color(0xFFA0A0A0))),
              const SizedBox(height: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 180),
                child: SingleChildScrollView(
                  child: Text(
                    widget.update.releaseNotes!,
                    style: const TextStyle(fontSize: 13, color: Color(0xFFC0C0C0), height: 1.5),
                  ),
                ),
              ),
            ],
          ],
        );
      case _UpdatePhase.downloading:
        final percent = _progress.percent;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '正在应用内下载安装包，请保持网络畅通…',
              style: TextStyle(fontSize: 13, color: Color(0xFFC0C0C0)),
            ),
            const SizedBox(height: 16),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: percent > 0 ? percent / 100 : null,
                minHeight: 6,
                backgroundColor: const Color(0xFF2A2A3A),
                valueColor: const AlwaysStoppedAnimation(Color(0xFF8B5CF6)),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '${_fmtBytes(_progress.received)} / ${_progress.total > 0 ? _fmtBytes(_progress.total) : '--'}（$percent%）',
              style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
            ),
          ],
        );
      case _UpdatePhase.verifying:
        return const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFF8B5CF6)),
            ),
            SizedBox(width: 12),
            Expanded(
              child: Text(
                '正在对下载包进行 SHA-256 完整性校验…',
                style: TextStyle(fontSize: 13, color: Color(0xFFC0C0C0)),
              ),
            ),
          ],
        );
      case _UpdatePhase.error:
        return Text(
          _error,
          style: const TextStyle(fontSize: 13, color: Color(0xFFFCA5A5), height: 1.5),
        );
    }
  }

  List<Widget> _buildActions() {
    switch (_phase) {
      case _UpdatePhase.info:
        return [
          if (!widget.update.forceUpdate)
            TextButton(
              onPressed: _close,
              child: const Text('稍后再说', style: TextStyle(fontSize: 13, color: Color(0xFF9CA3AF))),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF8B5CF6)),
            onPressed: _startDownload,
            child: const Text('下载更新', style: TextStyle(fontSize: 13, color: Colors.white)),
          ),
        ];
      case _UpdatePhase.downloading:
      case _UpdatePhase.verifying:
        // 下载/校验中不可关闭、不可操作（barrierDismissible=false + 无按钮）
        return const [];
      case _UpdatePhase.error:
        return [
          if (!widget.update.forceUpdate)
            TextButton(
              onPressed: _close,
              child: const Text('取消', style: TextStyle(fontSize: 13, color: Color(0xFF9CA3AF))),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF8B5CF6)),
            onPressed: _startDownload,
            child: const Text('重新下载', style: TextStyle(fontSize: 13, color: Colors.white)),
          ),
        ];
    }
  }

  static String _fmtBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}
