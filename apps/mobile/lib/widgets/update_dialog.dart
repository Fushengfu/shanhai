import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import '../services/update_service.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';

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


/// context-free 取词入口：沿用 7B 在 tool_step.dart 建立的同一形态（同一 resolvedLocale、同一份 ARB）。
/// 【为什么不在这里用 AppLocalizations.of(context)】of() 在 nullable-getter:false 下要求祖先必须装好
/// AppLocalizations.delegates；仓库既有测试 chat_view_scroll_test 就是把本组件挂在只带默认 delegate 的
/// MaterialApp 下跑的，of() 会直接抛 Null check operator。_l 不依赖祖先节点，且 7B 的 LS3 已实测
/// 「locale 变化会重建整棵页面子树 → context-free 取词同样跟切」，所以这里不是绕路，是同一套机制。
AppLocalizations get _l => lookupAppLocalizations(resolvedLocale(LocaleController.instance.value));
class _UpdateDialog extends StatefulWidget {
  final UpdateInfo update;
  const _UpdateDialog({required this.update});

  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  _UpdatePhase _phase = _UpdatePhase.info;
  DownloadProgress _progress = const DownloadProgress(received: 0, total: -1);
  /// 失败原因。存「怎么取词」而不是「取到的词」：它在 setState 里被写一次，
  /// 存字符串会把语言烘进 state（切语言后错误文案停在旧语言）。null = 还没有错误。
  L10nText? _error;

  Future<void> _startDownload() async {
    setState(() {
      _phase = _UpdatePhase.downloading;
      _error = null;
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
          _error = (l) => l.updateNoSha256;
        });
        return;
      }
      final ok = await UpdateService().verifyApkSha256(file, expected);
      if (!mounted) return;
      if (!ok) {
        try { file.deleteSync(); } catch (_) {}
        setState(() {
          _phase = _UpdatePhase.error;
          _error = (l) => l.updateShaMismatch;
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
        // $e 是异常原文（含 update_service 已本地化的句子），口径④不再加工
        _error = (l) => l.updateDownloadFailed('$e');
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
    final l = _l;
    // 四态标题全部取词（原来是一个 switch 表达式里的四个中文字面量）
    final (icon, text) = switch (_phase) {
      _UpdatePhase.info => (Icons.system_update_alt, l.updateFoundNew),
      _UpdatePhase.downloading => (Icons.downloading, l.updateTitleDownloading),
      _UpdatePhase.verifying => (Icons.verified_user_outlined, l.updateTitleVerifying),
      _UpdatePhase.error => (Icons.error_outline, l.updateTitleFailed),
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
            child: Text(l.updateForceTag, style: const TextStyle(fontSize: 11, color: Color(0xFFFCA5A5))),
          ),
      ],
    );
  }

  Widget _buildContent() {
    final l = _l;
    switch (_phase) {
      case _UpdatePhase.info:
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l.updateNewVersionLabel(widget.update.version),
              style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0), fontWeight: FontWeight.w600),
            ),
            if (widget.update.releaseNotes != null && widget.update.releaseNotes!.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(l.updateNotesLabel, style: const TextStyle(fontSize: 13, color: Color(0xFFA0A0A0))),
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
            Text(
              l.updateDownloadingHint,
              style: const TextStyle(fontSize: 13, color: Color(0xFFC0C0C0)),
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
              // 全角括号做成词条：英文界面不露异体字
              '${_fmtBytes(_progress.received)} / ${_progress.total > 0 ? _fmtBytes(_progress.total) : '--'}${l.updatePercentParen('$percent')}',
              style: const TextStyle(fontSize: 12, color: Color(0xFF9CA3AF)),
            ),
          ],
        );
      case _UpdatePhase.verifying:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFF8B5CF6)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                l.updateVerifyingHint,
                style: const TextStyle(fontSize: 13, color: Color(0xFFC0C0C0)),
              ),
            ),
          ],
        );
      case _UpdatePhase.error:
        return Text(
          _error != null ? _error!(l) : l.updateTitleFailed,
          style: const TextStyle(fontSize: 13, color: Color(0xFFFCA5A5), height: 1.5),
        );
    }
  }

  List<Widget> _buildActions() {
    final l = _l;
    switch (_phase) {
      case _UpdatePhase.info:
        return [
          if (!widget.update.forceUpdate)
            TextButton(
              onPressed: _close,
              child: Text(l.updateLater, style: const TextStyle(fontSize: 13, color: Color(0xFF9CA3AF))),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF8B5CF6)),
            onPressed: _startDownload,
            child: Text(l.updateDownloadBtn, style: const TextStyle(fontSize: 13, color: Colors.white)),
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
              child: Text(l.commonCancel, style: const TextStyle(fontSize: 13, color: Color(0xFF9CA3AF))),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF8B5CF6)),
            onPressed: _startDownload,
            child: Text(l.updateRedownload, style: const TextStyle(fontSize: 13, color: Colors.white)),
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
