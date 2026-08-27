import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 会员 JWT 的本地安全存储（走 Keychain / Keystore 加密存储）。
/// 跨重启保留登录态：登录成功后 save，启动时 read 自动登录，登出/token 失效时 clear。
class TokenStore {
  // resetOnError: true —— 华为等设备覆盖安装后 Keystore 里的加密 key 可能失效，
  // 导致 read() 抛异常（默认 resetOnError=false 会直接抛，使启动页「正在恢复登录」永久转圈）。
  // 开启后：解密失败时自动清除损坏数据并返回 null，走「未登录→回登录页」分支，不再卡死。
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(resetOnError: true),
  );
  static const _kToken = 'member_token';
  static const _kUsername = 'member_username';

  /// 登录成功后持久化 token 与账号（不存密码）。
  static Future<void> save(String token, String username) async {
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kUsername, value: username);
  }

  /// 读取缓存的会员 JWT；未登录返回 null。
  static Future<String?> readToken() => _storage.read(key: _kToken);

  /// 读取缓存账号；未登录返回 null。
  static Future<String?> readUsername() => _storage.read(key: _kUsername);

  /// 清除本地登录态（登出 / token 失效时调用）。
  static Future<void> clear() async {
    await _storage.delete(key: _kToken);
    await _storage.delete(key: _kUsername);
  }
}
