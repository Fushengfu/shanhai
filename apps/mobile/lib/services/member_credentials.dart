import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'token_store.dart';

/// 会员登录凭证（JWT）续签的**唯一复用点**（对应桌面端 `apps/desktop/src/main/member-credentials.ts`）。
///
/// 【为什么单独一个模块】
/// 会员 JWT 原 TTL=24h（网关已调整为 720h=30 天，并新增 7 天 refresh 宽限期）。改造前的故障链是：
/// 已建立的 ws 不受过期影响（网关只在握手时校验一次），但断线重连时旧 token 过期 → 网关握手回 401
/// → 手机端把任何 error 都当「登录已过期」直接 `TokenStore.clear()` 踢回登录页
/// → 电脑/手机关机过夜回来必须重新登录。本模块把「取凭证 + 到期主动续签 + 401 被动续签 + 失败分类」
/// 收敛到一处，`WsClient`（relay）与后续任何出网调用都调它，避免多套定时器互相漂移。
///
/// 【安全边界】
/// token 只存在 flutter_secure_storage（Keychain/Keystore）与本单例内存里；对外只广播
/// 「状态快照」（state / expiresAt / remainingMs / 错误文案），**不含 token 本体**。
///
/// 【与既有计时的关系（避免多套重复计时）】
/// - `WsClient` 自己的「断线重连指数退避」是**连接层**计时器，本模块是**凭证层**计时器；
///   两者只在 401 处交汇（本模块决定「值得重连」还是「该重新登录」），不合并、不互相复制。
/// - `UpdateService` 的版本检查是一次性请求，无周期计时，与本模块无关。
/// - 本模块的定时器只在「已登录」时运行，退出登录 / 凭证确认失效时清理。
class MemberCredentials {
  MemberCredentials._();

  static final MemberCredentials instance = MemberCredentials._();

  // —————————————————— 接口契约（与桌面端 member-credentials.ts 一致）—————————————————

  /// 续签接口基址：`POST https://aisocket.bjctykj.com/api/bridge/refresh_token`，无 body，
  /// 鉴权头 `Authorization: Bearer <会员JWT>`。与 bridge ws 同域。
  /// ⚠️ 生产需 nginx 暴露该路径才可达（网关侧确认「未暴露前返回 404」）→ 404 一律按**暂时性失败**处理。
  static const String bridgeApiBase = 'https://aisocket.bjctykj.com';
  static const String refreshPath = '/api/bridge/refresh_token';

  /// refresh 请求超时（避免挂起占住定时器）
  static const Duration refreshTimeout = Duration(seconds: 10);

  /// 主动续签阈值：剩余时间 < clamp(TTL × 20%, 5 分钟, 72 小时)。
  /// 不用「到期前 5 分钟」口径的理由：TTL=30 天后，5 分钟窗口要求应用恰好在到期前 5 分钟在线，
  /// 手机/笔记本常态是几天不重启或长期后台，极易错过；按剩余比例（30 天 → 提前约 72 小时）
  /// 配合 10 分钟一次的检查，「开机跑一会儿就顺手续上」。保留 5 分钟下限防 TTL 极短时阈值为 0。
  static const double renewAheadRatio = 0.2;
  static const Duration renewAheadMin = Duration(minutes: 5);
  static const Duration renewAheadMax = Duration(hours: 72);

  /// TTL 完全未知（老数据无 expires_at 且 JWT 解不出 exp/iat）但有绝对过期时间时，
  /// 采用的保守提前量：6 小时（远小于任何合理 TTL，又不至于「永远处于续签窗口」）。
  static const Duration renewAheadFallback = Duration(hours: 6);

  /// 凭证检查周期：每 10 分钟看一次「是否进入续签窗口」（远小于任何合理 TTL，不会漏窗）
  static const Duration tickInterval = Duration(minutes: 10);

  /// 续签失败退避：基础 1 分钟，指数翻倍，上限 6 小时（断网/网关故障期间不刷屏、不打爆网关）
  static const Duration retryBase = Duration(minutes: 1);
  static const Duration retryMax = Duration(hours: 6);

  /// 日志节流：连续失败只在第 1 次、之后每 10 次、或错误码变化时打印
  static const int logEvery = 10;

  /// 刚续签成功又立刻被拒的冷却窗口（防 refresh↔401 死循环）
  static const Duration postRotationCooldown = Duration(minutes: 1);

  // —————————————————— 状态定义 ——————————————————

  /// 凭证三态（外加两个辅助态）。**「未知」≠「已过期」**：老数据缺字段不得判过期。
  CredentialState _state = CredentialState.unknown;
  CredentialState get state => _state;

  String? _token;
  String? _username;
  int? _expiresAtMs;
  int? _ttlSeconds;
  String _expirySource = 'none'; // config=网关下发并落盘 / jwt=本地解码 JWT / none=未知

  Timer? _tickTimer;
  Timer? _retryTimer;
  Future<RefreshOutcome>? _inflight;
  int _failureCount = 0;
  String? _lastErrorCode;
  String? _lastError;
  int? _lastRotatedAt;
  int _lastRotationTs = 0;
  String? _loggedCode;

  /// 定时器归属者（页面级交接用）：只有同 owner 的 stop 才真正停表，
  /// 避免「启动页 dispose 把主页刚启动的续签定时器一起停掉」。
  String? _owner;

  final _statusCtrl = StreamController<CredentialSnapshot>.broadcast();

  /// 凭证状态流（不含 token 本体），供 UI 如实呈现「未登录 / 有效 / 即将到期 / 已失效 / 未知」
  Stream<CredentialSnapshot> get status => _statusCtrl.stream;

  CredentialSnapshot _snapshot = CredentialSnapshot.anonymous();
  CredentialSnapshot get snapshot => _snapshot;

  /// 当前可用的会员 JWT（null = 未登录）。连接层每次握手前都从这里取，
  /// 保证续签成功后重连一定用的是新 token，而不是页面里缓存的旧值。
  String? get accessToken => (_token != null && _token!.isNotEmpty) ? _token : null;

  bool get isSignedIn => accessToken != null;

  // —————————————————— 启动 / 生命周期 ——————————————————

  /// 从安全存储恢复登录态（含有效期）。启动页调用；幂等。
  Future<CredentialSnapshot> bootstrap() async {
    String? token;
    String? username;
    int? expiresAtMs;
    int? ttlSeconds;
    try {
      token = await TokenStore.readToken();
      username = await TokenStore.readUsername();
      final expiry = await TokenStore.readExpiry();
      expiresAtMs = expiry.expiresAtMs;
      ttlSeconds = expiry.ttlSeconds;
    } catch (e) {
      // 读存储异常（如 Keystore 损坏）：不崩、不判过期，退化为「未知」，
      // 后续由连接层的 401 兜底路径决定要不要清登录态。
      debugPrint('[credential] 读取本地登录态失败（按未知处理）: $e');
    }
    _username = username;
    if (token == null || token.isEmpty) {
      _token = null;
      _expiresAtMs = null;
      _ttlSeconds = null;
      _expirySource = 'none';
      return _emit(CredentialState.anonymous);
    }
    _token = token;
    if (expiresAtMs != null && expiresAtMs > 0) {
      _expiresAtMs = expiresAtMs;
      _ttlSeconds = ttlSeconds;
      _expirySource = 'config';
    } else {
      // 老版本存的 token 没有 expires_at：解码本地 JWT 的 exp/iat 兜底（不外发、不验签）
      final jwt = _decodeJwtExpiry(token);
      _expiresAtMs = jwt.expiresAtMs;
      _ttlSeconds = jwt.ttlSeconds ?? ttlSeconds;
      _expirySource = _expiresAtMs != null ? 'jwt' : 'none';
    }
    return _emit(_computeState());
  }

  /// 登录/注册成功：写入 token + 有效期并启动续签定时器。
  /// [expiresAtMs]/[ttlSeconds] 为 null（老网关没下发新字段）→ 存「未知」，不启动主动续签，
  /// 但仍保留定时器（等 401 被动兜底），取舍理由见 _tick()。
  Future<void> applyLogin({
    required String token,
    required String username,
    int? expiresAtMs,
    int? ttlSeconds,
    String owner = 'login',
  }) async {
    _token = token;
    _username = username;
    _expiresAtMs = expiresAtMs;
    _ttlSeconds = ttlSeconds;
    _expirySource = expiresAtMs != null ? 'config' : 'none';
    _failureCount = 0;
    _lastErrorCode = null;
    _lastError = null;
    try {
      await TokenStore.save(token, username, expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
    } catch (e) {
      debugPrint('[credential] 登录态落盘失败（不影响本次会话）: $e');
    }
    _emit(_computeState());
    start(owner);
  }

  /// 启动续签检查（幂等）。owner 用于页面交接：见 stop()。
  void start(String owner) {
    _owner = owner;
    if (_tickTimer != null) {
      _broadcast();
      return;
    }
    _tickTimer = Timer.periodic(tickInterval, (_) => _tick('timer'));
    // 不阻止进程退出/测试收尾
    _broadcast();
    // 启动即检查一次：覆盖「开机时凭证已过期」——不依赖 ws 是否连上
    unawaited(_tick('startup'));
  }

  /// 页面 dispose：只有「自己就是当前 owner」时才停表，
  /// 避免启动页→主页交接时把主页刚启动的定时器一起停掉。
  void stop(String owner) {
    if (_owner != owner) return;
    forceStop();
  }

  /// 无条件停表（退出登录 / 凭证确认失效 / App 退出）：杜绝「登出后还在打网关续签」。
  void forceStop() {
    _owner = null;
    _tickTimer?.cancel();
    _tickTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    _inflight = null;
    _failureCount = 0;
    _lastErrorCode = null;
    _lastError = null;
    _lastRotatedAt = null;
    _lastRotationTs = 0;
    _loggedCode = null;
    _broadcast();
  }

  /// 退出登录：停表 + 清内存凭证（存储由调用方 TokenStore.clear 负责）
  void onLoggedOut() {
    forceStop();
    _token = null;
    _username = null;
    _expiresAtMs = null;
    _ttlSeconds = null;
    _expirySource = 'none';
    _emit(CredentialState.anonymous);
  }

  // —————————————————— 状态计算 ——————————————————

  /// 续签提前量（毫秒）：TTL 已知按比例并 clamp 到 [5min, 72h]；TTL 未知用保守 6 小时。
  int _renewAheadMs() {
    final ttl = _ttlSeconds;
    if (ttl == null || ttl <= 0) return renewAheadFallback.inMilliseconds;
    final want = ttl * 1000 * renewAheadRatio;
    final floor = renewAheadMin.inMilliseconds;
    final cap = renewAheadMax.inMilliseconds;
    if (want < floor) return floor;
    if (want > cap) return cap;
    return want.toInt();
  }

  CredentialState _computeState() {
    if (accessToken == null) return CredentialState.anonymous;
    final exp = _expiresAtMs;
    if (exp == null) return CredentialState.unknown; // 未知：不主动续签、不判过期
    final remain = exp - DateTime.now().millisecondsSinceEpoch;
    if (remain <= 0) return CredentialState.expired;
    if (remain < _renewAheadMs()) return CredentialState.renewing;
    return CredentialState.valid;
  }

  /// 定时器主体：进入续签窗口/已过期才动手；unknown 不动手（无依据），等 401 兜底。
  Future<void> _tick(String trigger) async {
    final s = _computeState();
    if (s == CredentialState.anonymous) return;
    if (s == CredentialState.unknown || s == CredentialState.valid) return;
    await refresh(trigger);
  }

  CredentialSnapshot _emit(CredentialState s) {
    _state = s;
    return _broadcast();
  }

  CredentialSnapshot _broadcast() {
    final now = DateTime.now().millisecondsSinceEpoch;
    final snap = CredentialSnapshot(
      state: _state,
      username: _username,
      expiresAtMs: _expiresAtMs,
      ttlSeconds: _ttlSeconds,
      remainingMs: _expiresAtMs == null ? null : _expiresAtMs! - now,
      expirySource: _expirySource,
      renewalActive: _tickTimer != null,
      lastRotatedAt: _lastRotatedAt,
      lastErrorCode: _lastErrorCode,
      lastError: _lastError,
      failureCount: _failureCount,
      updatedAt: now,
    );
    _snapshot = snap;
    if (!_statusCtrl.isClosed) _statusCtrl.add(snap);
    return snap;
  }

  // —————————————————— 续签核心 ——————————————————

  /// 执行一次续签（单飞：并发调用共享同一个 in-flight，不会重复打网关）。
  Future<RefreshOutcome> refresh(String trigger) {
    final pending = _inflight;
    if (pending != null) return pending;
    final fut = _doRefresh(trigger);
    _inflight = fut;
    fut.whenComplete(() {
      if (identical(_inflight, fut)) _inflight = null;
    });
    return fut;
  }

  Future<RefreshOutcome> _doRefresh(String trigger) async {
    final token = accessToken;
    if (token == null) return RefreshOutcome.noToken; // 未登录：不是错误，什么都不做

    final http.Response res;
    try {
      res = await http
          .post(
            Uri.parse('$bridgeApiBase$refreshPath'),
            headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
            // 定稿契约：无 body
          )
          .timeout(refreshTimeout);
    } catch (e) {
      // 网络错误/超时/DNS：暂时性，保留登录态，退避重试，**绝不误登出**
      final msg = e is TimeoutException ? '续签超时（${refreshTimeout.inSeconds} 秒无响应）' : '续签请求失败：$e';
      _noteFailure('network', msg);
      _scheduleRetry();
      return RefreshOutcome.transient;
    }

    Map<String, dynamic>? body;
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map) body = decoded.cast<String, dynamic>();
    } catch (_) {
      body = null;
    }

    if (res.statusCode == 200) {
      final data = (body != null && body['data'] is Map)
          ? (body['data'] as Map).cast<String, dynamic>()
          : (body ?? <String, dynamic>{});
      final newToken = (data['token'] ?? '').toString().trim();
      if (newToken.isEmpty) {
        // 200 但没给 token：网关实现与契约不符 → 暂时性异常，不误登出
        _noteFailure('bad_response', '续签响应缺少 token');
        _scheduleRetry();
        return RefreshOutcome.transient;
      }
      final norm = _normalizeExpiry(data);
      _token = newToken;
      _expiresAtMs = norm.expiresAtMs;
      _ttlSeconds = norm.ttlSeconds;
      _expirySource = _expiresAtMs != null ? 'config' : 'none';
      try {
        await TokenStore.saveRotated(newToken, expiresAtMs: _expiresAtMs, ttlSeconds: _ttlSeconds);
      } catch (e) {
        debugPrint('[credential] 新凭证落盘失败（内存已更新，重启后需重登）: $e');
      }
      _failureCount = 0;
      _lastErrorCode = null;
      _lastError = null;
      _loggedCode = null;
      _lastRotatedAt = DateTime.now().millisecondsSinceEpoch;
      _lastRotationTs = _lastRotatedAt!;
      _retryTimer?.cancel();
      _retryTimer = null;
      debugPrint('[credential] 续签成功（触发方=$trigger），新凭证有效期至 '
          '${DateTime.fromMillisecondsSinceEpoch(_expiresAtMs ?? 0).toLocal()}；等待各连接带新 token 重连');
      _emit(_computeState());
      return RefreshOutcome.rotated;
    }

    // 非 200：优先取结构化错误码；网关未升级时 body 可能是纯文本 → 401 兜底按 token_expired 处理
    final code = _pickRejectCode(body) ?? (res.statusCode == 401 ? 'token_expired' : 'http_${res.statusCode}');
    final rawMsg = _pickRejectMessage(body, res.statusCode);
    // 只有「凭证本身不可恢复」才要求重新登录
    if (code == 'token_expired' || code == 'token_invalid' || code == 'token_missing' || res.statusCode == 403) {
      _noteFailure(code, rawMsg);
      await markCredentialInvalid('登录凭证已失效（$code），请重新登录', code);
      return RefreshOutcome.invalid;
    }
    // 404（网关未部署 / nginx 未暴露）/ 5xx / 其它：暂时性，保留登录态，退避重试
    _noteFailure(code, rawMsg);
    _scheduleRetry();
    return RefreshOutcome.transient;
  }

  /// 【401 统一入口】任何出网通道被网关以 401/403 拒绝时都调这里。
  ///
  /// 语义（定稿契约）：401 → 先尝试 refresh → 成功则带新 token 重连 → 只有 refresh 也失败才落到「重新登录」。
  /// 错误码区分：
  ///  - `token_missing` / `token_invalid` → 直接引导重登，不白试 refresh；
  ///  - `token_expired` → 试 refresh（宽限期内必成；超宽限 refresh 会再回 token_expired 才重登）；
  ///  - **拿不到结构化 code 时降级**（Dart 的 ws 握手失败读不到 401 的 JSON body，见 ws_client 注释）
  ///    → 一律先试一次 refresh，不依赖新错误码才工作。
  Future<RefreshOutcome> handleAuthRejected({
    required String source,
    int? status,
    String? code,
    String? message,
  }) async {
    final c = (code ?? '').trim();
    if (_lastRotationTs > 0 &&
        DateTime.now().millisecondsSinceEpoch - _lastRotationTs < postRotationCooldown.inMilliseconds &&
        c != 'token_expired') {
      await markCredentialInvalid('使用新凭证仍被网关拒绝（${c.isNotEmpty ? c : 'HTTP ${status ?? 401}'}），请重新登录',
          c.isNotEmpty ? c : 'rejected_after_rotation');
      return RefreshOutcome.invalid;
    }
    if (c == 'token_missing' || c == 'token_invalid') {
      await markCredentialInvalid('登录凭证无效或缺失，请重新登录', c);
      return RefreshOutcome.invalid;
    }
    if (accessToken == null) return RefreshOutcome.noToken;
    debugPrint('[credential] $source 通道被拒（401${c.isNotEmpty ? ' code=$c' : ''}），先尝试续签再重连');
    final outcome = await refresh('401:$source${c.isNotEmpty ? ':$c' : ''}');
    if (outcome == RefreshOutcome.rotated) return RefreshOutcome.rotated;
    if (outcome == RefreshOutcome.invalid) return RefreshOutcome.invalid;
    // transient：refresh 没成但不是凭证问题（网关挂了/未部署/断网）→ 不登出，让连接层继续按退避重连
    return RefreshOutcome.transient;
  }

  /// 凭证确认不可恢复的统一收尾：停表 + 清内存凭证 + 广播「已失效」（调用方负责回登录页）。
  ///
  /// 与桌面端的差异（手机端产品语义）：桌面端只翻 UI 态、不删本地凭证（有登录弹窗可原地重登）；
  /// 手机端没有登录弹窗，唯一重登路径是回到 LoginPage，因此这里必须清掉内存 token，
  /// 否则 `bootstrap()` 下次仍会拿一份必被拒的旧 token 反复 401。
  Future<void> markCredentialInvalid(String reason, String? code) async {
    _lastErrorCode = code ?? _lastErrorCode;
    _lastError = reason;
    forceStop();
    _token = null;
    _username = null;
    _expiresAtMs = null;
    _ttlSeconds = null;
    _expirySource = 'none';
    try {
      await TokenStore.clear();
    } catch (e) {
      debugPrint('[credential] 清理失效凭证失败: $e');
    }
    debugPrint('[credential] 凭证已判定失效：$reason');
    _emit(CredentialState.anonymous);
  }

  void _noteFailure(String code, String message) {
    _failureCount += 1;
    _lastErrorCode = code;
    _lastError = message;
    if (_loggedCode != code || _failureCount == 1 || _failureCount % logEvery == 0) {
      _loggedCode = code;
      debugPrint('[credential] 续签失败（第 $_failureCount 次，code=$code）：$message');
    }
    _emit(_computeState());
  }

  void _scheduleRetry() {
    if (_retryTimer != null) return;
    if (accessToken == null) return; // 已无凭证（未登录/已失效）：不再重试
    final n = max(0, _failureCount - 1);
    var ms = retryBase.inMilliseconds * pow(2, min(n, 20));
    if (ms > retryMax.inMilliseconds) ms = retryMax.inMilliseconds;
    final jitter = ms * (0.85 + Random().nextDouble() * 0.3);
    _retryTimer = Timer(Duration(milliseconds: jitter.round()), () {
      _retryTimer = null;
      unawaited(refresh('retry'));
    });
  }

  // —————————————————— 解析辅助 ——————————————————

  /// 把网关的 `expires_at` / `expires_in` 归一成「绝对毫秒 + TTL 秒」，兼容秒/毫秒两种量纲。
  ({int? expiresAtMs, int? ttlSeconds}) _normalizeExpiry(Map<String, dynamic> data) {
    final rawAt = data['expires_at'] ?? data['expiresAt'];
    final rawIn = data['expires_in'] ?? data['expiresIn'];
    final atNum = rawAt is num ? rawAt.toDouble() : double.tryParse(rawAt?.toString() ?? '');
    final inNum = rawIn is num ? rawIn.toDouble() : double.tryParse(rawIn?.toString() ?? '');
    int? expiresAtMs;
    if (atNum != null && atNum > 0) {
      // 定稿说 unix 秒；但 >1e12 只能是毫秒，按位数判定，避免把毫秒当秒算出 4.5 万年后
      expiresAtMs = atNum > 1e12 ? atNum.round() : (atNum * 1000).round();
    }
    int? ttlSeconds = (inNum != null && inNum > 0) ? inNum.round() : null;
    if (expiresAtMs == null && ttlSeconds != null) {
      expiresAtMs = DateTime.now().millisecondsSinceEpoch + ttlSeconds * 1000;
    }
    return (expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
  }

  /// 解码 JWT payload 的 exp/iat（只读本地已有 token，不验签、不外发）；解不出返回 null。
  ({int? expiresAtMs, int? ttlSeconds}) _decodeJwtExpiry(String token) {
    try {
      final parts = token.split('.');
      if (parts.length < 2) return (expiresAtMs: null, ttlSeconds: null);
      var seg = parts[1];
      final pad = seg.length % 4;
      if (pad != 0) seg += '=' * (4 - pad);
      final map = jsonDecode(utf8.decode(base64Url.decode(seg)));
      if (map is! Map) return (expiresAtMs: null, ttlSeconds: null);
      final exp = map['exp'];
      final iat = map['iat'];
      final expNum = exp is num ? exp.toDouble() : double.tryParse(exp?.toString() ?? '');
      final iatNum = iat is num ? iat.toDouble() : double.tryParse(iat?.toString() ?? '');
      final expiresAtMs = (expNum != null && expNum > 0) ? (expNum * 1000).round() : null;
      final ttlSeconds = (expNum != null && iatNum != null && expNum > iatNum) ? (expNum - iatNum).round() : null;
      return (expiresAtMs: expiresAtMs, ttlSeconds: ttlSeconds);
    } catch (_) {
      return (expiresAtMs: null, ttlSeconds: null);
    }
  }

  String? _pickRejectCode(Map<String, dynamic>? body) {
    if (body == null) return null;
    for (final k in ['code', 'error_code', 'errcode']) {
      final v = body[k];
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    final data = body['data'];
    if (data is Map) {
      final c = data['code'];
      if (c is String && c.trim().isNotEmpty) return c.trim();
    }
    return null;
  }

  String _pickRejectMessage(Map<String, dynamic>? body, int status) {
    if (body != null) {
      for (final k in ['error', 'message', 'msg']) {
        final v = body[k];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
    return 'HTTP $status';
  }
}

/// 凭证状态（**「未知」与「已过期」必须分开**：老数据缺 expires_at 不得判过期）
enum CredentialState { anonymous, valid, renewing, expired, unknown }

/// 续签结果分类：调用方据此决定「重连 / 要求重登 / 只重试」
enum RefreshOutcome {
  /// 已拿到新 token 并落盘，使用方应带新 token 重连
  rotated,

  /// 凭证不可恢复（超宽限 / token_invalid / token_missing）→ 必须重新登录
  invalid,

  /// 暂时性失败（网络/超时/5xx/404/网关未部署）→ 保留登录态，稍后重试，不得误登出
  transient,

  /// 本地没有 token（未登录）：什么都不做
  noToken,
}

/// 凭证状态快照（可安全下发 UI：不含 token 本体）
class CredentialSnapshot {
  final CredentialState state;
  final String? username;
  final int? expiresAtMs;
  final int? ttlSeconds;

  /// 距过期剩余毫秒；已过期为负；未知为 null
  final int? remainingMs;

  /// 过期时间来源：config=网关下发并落盘 / jwt=本地解码 JWT exp / none=未知（界面如实标注用）
  final String expirySource;
  final bool renewalActive;
  final int? lastRotatedAt;
  final String? lastErrorCode;
  final String? lastError;
  final int failureCount;
  final int updatedAt;

  const CredentialSnapshot({
    required this.state,
    this.username,
    this.expiresAtMs,
    this.ttlSeconds,
    this.remainingMs,
    this.expirySource = 'none',
    this.renewalActive = false,
    this.lastRotatedAt,
    this.lastErrorCode,
    this.lastError,
    this.failureCount = 0,
    this.updatedAt = 0,
  });

  factory CredentialSnapshot.anonymous() => const CredentialSnapshot(state: CredentialState.anonymous);

  /// 一句人话的状态描述（登录页/主页横幅/关于信息复用，避免各处文案漂移）
  String describe() {
    switch (state) {
      case CredentialState.anonymous:
        return '未登录会员账号';
      case CredentialState.valid:
        return '已登录（凭证剩余约 ${_human(remainingMs)}）';
      case CredentialState.renewing:
        return '登录凭证即将到期（剩余约 ${_human(remainingMs)}），已自动续签';
      case CredentialState.expired:
        return '登录凭证已过期（正在尝试自动续签，期间远程连接可能不可用）';
      case CredentialState.unknown:
        return '已登录（凭证有效期未知：本地未记录过期时间，按可用处理）';
    }
  }

  static String _human(int? ms) {
    if (ms == null) return '未知';
    final abs = ms.abs();
    final h = abs ~/ Duration.millisecondsPerHour;
    final m = (abs % Duration.millisecondsPerHour) ~/ Duration.millisecondsPerMinute;
    if (h >= 24) return '${h ~/ 24} 天 ${h % 24} 小时';
    if (h > 0) return '$h 小时 $m 分钟';
    return '$m 分钟';
  }
}
