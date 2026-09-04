import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

/// 登录结果：会员 JWT + （网关新增的）有效期信息。
///
/// [expiresAtMs] / [ttlSeconds] 为 null 表示**网关没下发** `expires_at` / `expires_in`
/// （老版本网关，或本次登录走的是未升级的实例）。调用方必须按「有效期未知」处理：
/// **不得判为已过期**、不启动主动续签，等 401 被动兜底。
class LoginResult {
  final String token;
  final int? expiresAtMs;
  final int? ttlSeconds;

  const LoginResult({required this.token, this.expiresAtMs, this.ttlSeconds});

  /// 有效期是否已知（界面如实标注「凭证有效期未知」用）
  bool get expiryKnown => expiresAtMs != null;
}

/// 会员登录服务：账号密码登录（密码 SHA-256 小写 hex），换取会员 JWT。
/// 与桌面端 packages/auth 登录协议保持一致：POST /api/member/login，body {username, password}。
class AuthService {
  /// 会员体系基地址（登录 / 拉模型列表用）
  final String baseUrl;

  AuthService({this.baseUrl = 'https://agent.bjctykj.com'});

  /// SHA-256 后转小写 hex（服务端按密文校验，明文会返回 invalid password）
  String sha256Hex(String input) {
    return sha256.convert(utf8.encode(input)).toString();
  }

  /// 登录，成功返回 [LoginResult]（含 token 与有效期）；失败抛异常（含服务端 message）
  Future<LoginResult> login(String username, String password) async {
    final passwordHash = sha256Hex(password);
    final res = await http
        .post(
          Uri.parse('${baseUrl.replaceAll(RegExp(r'/$'), '')}/api/member/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'username': username, 'password': passwordHash}),
        )
        .timeout(const Duration(seconds: 20));

    final Map<String, dynamic> body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      throw Exception('登录失败：HTTP ${res.statusCode}，响应解析异常');
    }

    final data = body['data'] as Map<String, dynamic>?;
    // 网关响应兼容多种 token 字段（与桌面端一致）
    final token = data?['token'] ??
        body['token'] ??
        data?['memberToken'] ??
        body['memberToken'] ??
        data?['access_token'] ??
        body['access_token'];

    if (token == null || token.toString().isEmpty) {
      final msg = (body['message'] ?? '登录失败') as String;
      throw Exception(msg);
    }
    // 网关本轮新增的有效期字段（unix 秒；纯增量，旧字段不变）。
    // 兼容 data 层与顶层两种摆放、以及 snake_case / camelCase 两种写法。
    final expiry = _parseExpiry(data ?? const <String, dynamic>{}, body);
    return LoginResult(token: token.toString(), expiresAtMs: expiry.expiresAtMs, ttlSeconds: expiry.ttlSeconds);
  }

  /// 把 `expires_at` / `expires_in` 归一成「绝对毫秒 + TTL 秒」，兼容秒/毫秒两种量纲。
  /// 与桌面端 member-credentials.ts 的 normalizeExpiry 同一套规则，保证两端判定一致。
  static ({int? expiresAtMs, int? ttlSeconds}) _parseExpiry(
    Map<String, dynamic> data,
    Map<String, dynamic> body,
  ) {
    final rawAt = data['expires_at'] ?? data['expiresAt'] ?? body['expires_at'] ?? body['expiresAt'];
    final rawIn = data['expires_in'] ?? data['expiresIn'] ?? body['expires_in'] ?? body['expiresIn'];
    final atNum = rawAt is num ? rawAt.toDouble() : double.tryParse(rawAt?.toString() ?? '');
    final inNum = rawIn is num ? rawIn.toDouble() : double.tryParse(rawIn?.toString() ?? '');
    int? expiresAtMs;
    if (atNum != null && atNum > 0) {
      // 定稿说 unix 秒；但 >1e12 只能是毫秒，按位数判定，避免把毫秒当秒算出 4.5 万年后
      expiresAtMs = atNum > 1e12 ? atNum.round() : (atNum * 1000).round();
    }
    final ttlSeconds = (inNum != null && inNum > 0) ? inNum.round() : null;
    if (expiresAtMs == null && ttlSeconds != null) {
      expiresAtMs = DateTime.now().millisecondsSinceEpoch + ttlSeconds * 1000;
    }
    return (expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
  }
}
