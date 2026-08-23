import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

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

  /// 登录，成功返回会员 JWT；失败抛异常（含服务端 message）
  Future<String> login(String username, String password) async {
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
    return token.toString();
  }
}
