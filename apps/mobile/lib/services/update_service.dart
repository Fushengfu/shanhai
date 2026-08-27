import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

/// 单次版本检查返回的最新版本信息。
class UpdateInfo {
  final String version;
  final int? versionCode;
  final String downloadUrl;
  final String? releaseNotes;
  final bool forceUpdate;

  const UpdateInfo({
    required this.version,
    this.versionCode,
    required this.downloadUrl,
    this.releaseNotes,
    this.forceUpdate = false,
  });
}

/// 版本检查结果：hasUpdate 表示是否有比当前更新的版本。
class UpdateCheckResult {
  final bool hasUpdate;
  final UpdateInfo? update;
  final String? error;

  const UpdateCheckResult({required this.hasUpdate, this.update, this.error});
}

/// 手机端版本检查更新服务。
/// 复用桌面端 app-updater 同一个网关公开接口（无需鉴权）：
/// GET /api/v1/app/version/check?type=Android&packageName=当前包名
/// 返回 envelope：{ code, message, data: { version, version_code, download_url, force_update, release_notes } }
class UpdateService {
  static const String _apiBase = 'https://aigateway.bjctykj.com';
  static const String _versionCheckUrl = '$_apiBase/api/v1/app/version/check';

  /// 从网关版本检查 API 拉取最新版本并与当前版本比较。
  /// 失败（网络 / 解析 / 无 download_url）不抛异常，返回 hasUpdate=false + error 描述。
  Future<UpdateCheckResult> check() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final currentVersion = info.version; // versionName，如 "1.0.0"
      final currentCode = _parseInt(info.buildNumber); // versionCode，如 "1"

      final query = Uri(queryParameters: {
        'type': 'Android',
        'packageName': info.packageName,
      });
      final url = Uri.parse('$_versionCheckUrl?$query');

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
        ),
      );
    } catch (e) {
      return UpdateCheckResult(
        hasUpdate: false,
        error: e.toString(),
      );
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
