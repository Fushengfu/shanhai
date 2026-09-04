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

  /// 凭证绝对过期时间（**毫秒**时间戳的字符串形式）。
  /// 与 token 同批写入；老版本没这个键 → read 返回 null，按「有效期未知」处理（不得判过期）。
  static const _kExpiresAt = 'member_token_expires_at';

  /// 凭证 TTL（秒），用于计算「剩余 20% 就续签」的阈值。同样允许缺失。
  static const _kTtlSeconds = 'member_token_ttl_seconds';

  /// 登录成功后持久化 token、账号与（可选）有效期（不存密码）。
  ///
  /// [expiresAtMs] / [ttlSeconds] 为 null 表示「登录接口没给有效期」（老网关或未部署新字段）：
  /// 这时**删除**可能残留的旧键，避免沿用上一份 token 的过期时间造成误判。
  static Future<void> save(
    String token,
    String username, {
    int? expiresAtMs,
    int? ttlSeconds,
  }) async {
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kUsername, value: username);
    await writeExpiry(expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
  }

  /// 只更新 token 与有效期（续签成功时用，账号名不变）。
  static Future<void> saveRotated(
    String token, {
    int? expiresAtMs,
    int? ttlSeconds,
  }) async {
    await _storage.write(key: _kToken, value: token);
    await writeExpiry(expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
  }

  /// 写入/清除有效期字段。单独抽出来，保证「无值即删」的语义只有一处实现。
  static Future<void> writeExpiry({int? expiresAtMs, int? ttlSeconds}) async {
    if (expiresAtMs != null && expiresAtMs > 0) {
      await _storage.write(key: _kExpiresAt, value: expiresAtMs.toString());
    } else {
      await _storage.delete(key: _kExpiresAt);
    }
    if (ttlSeconds != null && ttlSeconds > 0) {
      await _storage.write(key: _kTtlSeconds, value: ttlSeconds.toString());
    } else {
      await _storage.delete(key: _kTtlSeconds);
    }
  }

  /// 读取缓存的会员 JWT；未登录返回 null。
  static Future<String?> readToken() => _storage.read(key: _kToken);

  /// 读取缓存账号；未登录返回 null。
  static Future<String?> readUsername() => _storage.read(key: _kUsername);

  /// 读取凭证有效期；**返回 null = 未知**（老数据没这两个键，或网关没下发）。
  /// 调用方必须把 null 当「未知」而不是「已过期」——见 MemberCredentials 的降级说明。
  static Future<({int? expiresAtMs, int? ttlSeconds})> readExpiry() async {
    final rawAt = await _storage.read(key: _kExpiresAt);
    final rawTtl = await _storage.read(key: _kTtlSeconds);
    return (expiresAtMs: int.tryParse(rawAt ?? ''), ttlSeconds: int.tryParse(rawTtl ?? ''));
  }

  /// 清除本地登录态（登出 / token 确认失效时调用）。
  static Future<void> clear() async {
    await _storage.delete(key: _kToken);
    await _storage.delete(key: _kUsername);
    await _storage.delete(key: _kExpiresAt);
    await _storage.delete(key: _kTtlSeconds);
  }
}
