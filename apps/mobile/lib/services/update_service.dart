import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

/// 单次版本检查返回的最新版本信息。
class UpdateInfo {
  final String version;
  final int? versionCode;
  final String downloadUrl;
  final String? releaseNotes;
  final bool forceUpdate;
  /// 更新包 SHA-256（小写 hex，64 字符）。
  /// 来源：网关 /api/v1/app/version/check 响应的 hash / sha256_sum / sha256Sum（三字段同值，
  /// 由 AI网关 admin 前端用 WebCrypto SHA-256 对文件全量二进制计算后存储，后端原样返回）。
  /// 为空表示网关未配置校验值（后端不校验格式，可能为空/错值）——按协议「宁缺毋滥」，下载后校验不过并报错。
  final String? sha256;

  const UpdateInfo({
    required this.version,
    this.versionCode,
    required this.downloadUrl,
    this.releaseNotes,
    this.forceUpdate = false,
    this.sha256,
  });
}

/// 版本检查结果：hasUpdate 表示是否有比当前更新的版本。
class UpdateCheckResult {
  final bool hasUpdate;
  final UpdateInfo? update;
  final String? error;

  const UpdateCheckResult({required this.hasUpdate, this.update, this.error});
}

/// 下载进度（received 已下载字节 / total 总字节，total=-1 表示未知）。
class DownloadProgress {
  final int received;
  final int total;
  const DownloadProgress({required this.received, required this.total});

  int get percent {
    if (total <= 0) return 0;
    return ((received / total) * 100).round().clamp(0, 100);
  }
}

/// 手机端版本检查更新服务。
/// 复用桌面端 app-updater 同一个网关公开接口（无需鉴权）：
/// GET /api/v1/app/version/check?type=Android&packageName=当前包名
/// 返回 envelope：{ code, message, data: { version, version_code, download_url, force_update, release_notes, hash/sha256_sum/sha256Sum } }
///
/// 升级链路（应用内完整升级）：
///   check() 发现新版本 → showUpdateDialog 展示 → 应用内流式下载（带进度）→ SHA-256 完整性校验
///   → 校验通过后经 MethodChannel 拉起系统安装器（FileProvider content:// URI + ACTION_VIEW）。
class UpdateService {
  static const String _apiBase = 'https://aigateway.bjctykj.com';
  static const String _versionCheckUrl = '$_apiBase/api/v1/app/version/check';

  /// 应用内安装通道（Android MainActivity 注册）。
  static const MethodChannel _installerChannel = MethodChannel('shanhai/installer');

  /// 从网关版本检查 API 拉取最新版本并与当前版本比较。
  /// 失败（网络 / 解析 / 无 download_url）不抛异常，返回 hasUpdate=false + error 描述。
  Future<UpdateCheckResult> check() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final currentVersion = info.version; // versionName，如 "1.0.0"
      final currentCode = _parseInt(info.buildNumber); // versionCode，如 "2004"

      final url = Uri.parse(_versionCheckUrl).replace(queryParameters: {
        'type': 'Android',
        'packageName': info.packageName,
      });

      final res = await http
          .get(url, headers: {'Content-Type': 'application/json'})
          .timeout(const Duration(seconds: 20));

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return UpdateCheckResult(
          hasUpdate: false,
          error: '版本检查失败：HTTP ${res.statusCode}',
        );
      }

      final Map<String, dynamic> body;
      try {
        body = jsonDecode(res.body) as Map<String, dynamic>;
      } catch (_) {
        return const UpdateCheckResult(
          hasUpdate: false,
          error: '版本检查响应解析失败',
        );
      }

      final code = body['code'];
      if (code != null && code is int && code != 0) {
        return UpdateCheckResult(
          hasUpdate: false,
          error: '版本检查失败：${body['message'] ?? code}',
        );
      }

      final data = (body['data'] as Map<String, dynamic>?) ?? body;
      final latestVersion = _str(data['version']);
      final downloadUrl =
          _str(data['download_url'] ?? data['downloadUrl']);
      if (downloadUrl.isEmpty) {
        return const UpdateCheckResult(
          hasUpdate: false,
          error: '网关未下发可下载的安装包',
        );
      }

      final latestCode = _parseInt(data['version_code'] ?? data['versionCode']);
      final forceUpdate =
          (data['force_update'] ?? data['forceUpdate']) == true;
      final releaseNotes = _str(
        data['release_notes'] ?? data['releaseNotes'],
      );
      // hash 字段：网关同时返回 hash / sha256_sum / sha256Sum（三字段同值），建议读 hash 或 sha256_sum
      final sha256 = _str(
        data['hash'] ?? data['sha256_sum'] ?? data['sha256Sum'],
      );

      final hasUpdate = _isNewer(
        currentCode: currentCode,
        currentVersion: currentVersion,
        latestCode: latestCode,
        latestVersion: latestVersion,
      );

      return UpdateCheckResult(
        hasUpdate: hasUpdate,
        update: UpdateInfo(
          version: latestVersion,
          versionCode: latestCode,
          downloadUrl: downloadUrl,
          releaseNotes: releaseNotes.isEmpty ? null : releaseNotes,
          forceUpdate: forceUpdate,
          sha256: sha256.isEmpty ? null : sha256,
        ),
      );
    } catch (e) {
      return UpdateCheckResult(
        hasUpdate: false,
        error: e.toString(),
      );
    }
  }

  /// 应用内流式下载 APK 到本地文件，边下边回调进度。
  /// 失败抛异常（HTTP 错误 / 网络中断），由调用方捕获并提示重试。
  Future<File> downloadApk({
    required String url,
    required String targetPath,
    required void Function(DownloadProgress) onProgress,
  }) async {
    final client = http.Client();
    try {
      final request = http.Request('GET', Uri.parse(url));
      final streamed =
          await client.send(request).timeout(const Duration(seconds: 30));
      if (streamed.statusCode < 200 || streamed.statusCode >= 300) {
        throw HttpException('下载失败：HTTP ${streamed.statusCode}');
      }
      final total = streamed.contentLength ?? -1;
      final file = File(targetPath);
      final sink = file.openWrite();
      var received = 0;
      try {
        await for (final chunk in streamed.stream) {
          sink.add(chunk);
          received += chunk.length;
          onProgress(DownloadProgress(received: received, total: total));
        }
      } finally {
        await sink.close();
      }
      return file;
    } finally {
      client.close();
    }
  }

  /// SHA-256 完整性校验：对 APK 文件全量二进制分块计算 SHA-256，与网关下发的小写 hex 忽略大小写对比。
  /// 协议：AI网关 admin 前端 WebCrypto SHA-256 计算整个文件 arrayBuffer → 小写 hex 64 字符。
  /// 返回 false 表示不匹配或网关未配置校验值。
  Future<bool> verifyApkSha256(File apk, String expectedSha256) async {
    final expected = expectedSha256.trim();
    if (expected.isEmpty) return false; // 网关未配置校验值
    try {
      final digest = await sha256.bind(apk.openRead()).first;
      return digest.toString().toLowerCase() == expected.toLowerCase();
    } catch (_) {
      return false;
    }
  }

  /// 校验通过后拉起系统安装器：
  /// MainActivity 侧用 FileProvider.getUriForFile 生成 content:// URI（external-files-path
  /// 与下载目录精确匹配）+ ACTION_VIEW + setDataAndType(application/vnd.android.package-archive)
  /// + FLAG_GRANT_READ_URI_PERMISSION 拉起系统安装器。
  Future<void> installApk(File apk) async {
    try {
      await _installerChannel
          .invokeMethod('installApk', {'path': apk.path});
    } on PlatformException catch (e) {
      if (e.code == 'UNKNOWN_SOURCE') {
        throw Exception('需要允许安装未知应用后才能升级，请到系统设置开启「允许安装此来源的应用」后重试');
      }
      throw Exception('调用系统安装器失败：${e.message ?? e.code}');
    }
  }

  /// 版本比较：优先用 version_code（数字），否则退化到 version 字符串比较。
  static bool _isNewer({
    required int? currentCode,
    required String currentVersion,
    required int? latestCode,
    required String latestVersion,
  }) {
    if (currentCode != null && latestCode != null) {
      return latestCode > currentCode;
    }
    // 退化到三段式字符串比较
    return _compareVersion(latestVersion, currentVersion) > 0;
  }

  static int _compareVersion(String a, String b) {
    final pa = _versionParts(a);
    final pb = _versionParts(b);
    for (var i = 0; i < 4; i++) {
      final va = pa[i];
      final vb = pb[i];
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  static List<int> _versionParts(String version) {
    final parts = version
        .split('.')
        .map((p) => _parseInt(p) ?? 0)
        .toList();
    while (parts.length < 4) {
      parts.add(0);
    }
    return parts.take(4).toList();
  }

  static int? _parseInt(dynamic value) {
    if (value == null) return null;
    final text = value.toString().replaceAll(RegExp(r'[^\d]'), '');
    if (text.isEmpty) return null;
    return int.tryParse(text);
  }

  static String _str(dynamic value) {
    return value == null ? '' : value.toString().trim();
  }
}
