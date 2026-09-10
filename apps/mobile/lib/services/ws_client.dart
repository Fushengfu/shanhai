import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'member_credentials.dart';
import '../l10n/generated/app_localizations.dart';
import '../locale.dart';

/// 连接状态
enum ConnState { disconnected, connecting, connected, paired }

/// 服务端推送的事件

/// context-free 取词入口（与 7B 的 tool_step.dart、7C 的 update_service 同一形态）：服务层拿不到 BuildContext。
/// 与 MaterialApp 的 locale 共用 resolvedLocale，语言只跟手机自己（不读桌面端语言）。
AppLocalizations get _l => lookupAppLocalizations(resolvedLocale(LocaleController.instance.value));
class ServerEvent {
  final String event;
  final Map<String, dynamic> payload;
  ServerEvent(this.event, this.payload);
}

/// 命令结果
class CmdResult {
  final bool ok;
  final dynamic data;
  final String? error;

  /// 这次失败是不是「挂满 60 秒兜底超时」才失败的（见 [WsClient.sendCommand] 的 onTimeout）。
  ///
  /// 为什么要在结果里带上这个：重试口径按失败原因分岔 ——
  /// 「断线 / 没送出去」可以重试（重发一次就有机会成功），
  /// 「跑满超时」**不重试**（命令很可能早就到桌面端并被执行了，只是回包丢了；
  /// 再等一个 60 秒只会把用户从「弹一次超时」拖成「干等三分钟」）。
  /// 之前只能靠 error 文案判断，而文案是本地化过的（中英双语），靠字符串比对必错。
  final bool timedOut;

  CmdResult(this.ok, this.data, this.error, {this.timedOut = false});
}

/// 只读命令白名单：这些命令**不改变桌面端状态**（核过 remote-protocol.ts 的 case 分支，
/// 全部只是读数据），断线后重发不会造成副作用，因此允许自动重试（见 [sendCommandWithRetry]）。
///
/// 写类命令**一律不在本表内**（send_message / resume / resend / run_supervisor /
/// create_session / rename_session / delete_session / respond_ask / cancel_ask /
/// respond_approval / stop_session）：重试 = 同一需求被下发两遍（甚至两次执行），
/// 宁可按失败如实告诉用户，由页面用 get_history 对账，也不自动重发。
const Set<String> idempotentCommands = <String>{
  'list_sessions', // case 'list_sessions': data = listSessionsFull()（只读）
  'get_history', // case 'get_history': data = buildHistoryPayload(...)（只读）
  'get_supervisor_history', // case 'get_supervisor_history': 同上，固定 SUPERVISOR_ID（只读）
  'get_models', // case 'get_models': data = await runtime.listModels()（只读，当前手机端未下发）
  'get_pending_requests', // case 'get_pending_requests': 只读查询待处理审批/提问（恢复弹窗用）
  'get_token_stats', // case 'get_token_stats': data = runtime.getTokenStats()（只读，当前手机端未下发）
};

/// 一条命令最多尝试几次：只读命令 3 次（1 次原始 + 2 次重试），写类命令恒为 1（不重试）。
/// 写死常数、不做「重试到成功为止」——上界是硬要求，否则弱网下会永远重试。
const int maxReadOnlyAttempts = 3;

int commandMaxAttempts(String cmd) =>
    idempotentCommands.contains(cmd) ? maxReadOnlyAttempts : 1;

/// 这次失败**值不值得重试** —— 只认失败原因，不看文案（文案是本地化的，中英两份）。
///
/// 口径（管家 2026-09-10 裁决，收窄 199 的初版）：
///  · 「断线 / 没送出去」（连接断开被 [PendingCommands.failAll] 统一失败、_canSend 为假、
///    sink.add 抛异常）：允许重试 —— 重发一次就有机会成功，且只读命令重发无副作用。
///  · 「挂满 60 秒兜底超时」（[CmdResult.timedOut]）：**一次都不重试**。
///    理由：用户要的是「别老弹超时」，让他干等 3×60s 比如实弹一次更糟；
///    而且超时往往意味着命令早已送达并被桌面端执行，重发只是再等一遍。
bool shouldRetryFailure(CmdResult r) => !r.ok && !r.timedOut;

/// 重试之间的退避：400ms → 800ms（递增、有上界）。
/// 取值理由：单条命令的 60 秒超时本身已很慢（见 [WsClient.sendCommand]），
/// 重试必须「几乎无感」才有意义；两次退避合计 1.2 秒，给了抖动/重连恢复的窗口，
/// 又不至于把一次真失败拖成「点了没反应」。上界 2 秒防止将来调大尝试次数时退避失控。
Duration commandRetryBackoff(int attempt) {
  final ms = min(400 * pow(2, attempt - 1), 2000).round();
  return Duration(milliseconds: ms);
}

/// 带重试的命令发送循环（[WsClient.sendCommand] 走的就是这一份实现，不存在第二份策略）。
/// 抽成顶层函数是为了让「只读重试 / 写类不重试 / 超时不重试 / 重试有上界」能被直接断言（无需 socket）。
/// 注意循环条件是 [shouldRetryFailure]（按**失败原因**判定），不是「只要 !ok 就重试」——
/// 后者会把一次 60 秒超时放大成 3 次，正是 202 要收窄的那条。
/// [sleepFor] 仅供断言退避节奏时注入，生产路径不传（走真实延时）。
Future<CmdResult> sendCommandWithRetry(
  String cmd,
  Future<CmdResult> Function() sendOnce, {
  Future<void> Function(Duration)? sleepFor,
}) async {
  final maxAttempts = commandMaxAttempts(cmd);
  var result = await sendOnce();
  for (var attempt = 1; attempt < maxAttempts && shouldRetryFailure(result); attempt++) {
    final wait = commandRetryBackoff(attempt);
    if (sleepFor != null) {
      await sleepFor(wait);
    } else {
      await Future<void>.delayed(wait);
    }
    result = await sendOnce();
  }
  return result;
}

/// 一条在途命令：命令名（决定要不要重试）+ 等待结果的 completer。
class _PendingCmd {
  final String cmd;
  final Completer<CmdResult> completer;
  _PendingCmd(this.cmd, this.completer);
}

/// 在途命令登记表。
///
/// 存在的理由：连接断开（拔线 / 切 Wi‑Fi↔4G / 桌面端休眠 / 用户主动切设备）时，
/// 这些命令**不可能**再拿到结果，必须立刻失败并告诉用户，而不是各自白等满 60 秒
/// 才报「命令超时」——用户在弱网下看到的就是那个 60 秒。
class PendingCommands {
  final Map<int, _PendingCmd> _items = <int, _PendingCmd>{};

  int get length => _items.length;
  bool get isEmpty => _items.isEmpty;
  bool contains(int id) => _items.containsKey(id);

  void add(int id, String cmd, Completer<CmdResult> completer) {
    _items[id] = _PendingCmd(cmd, completer);
  }

  /// 取走并移除（收到 cmd_result 时用）：取走即从此不可能被二次完成。
  Completer<CmdResult>? take(int id) => _items.remove(id)?.completer;

  /// 让所有在途命令立即失败并**清空**登记表，返回被完成的条数。
  ///
  /// 三条硬约束（都有对应断言）：
  ///  ① 一条不丢：先整体快照再逐条处理，不做「边遍历边删」；
  ///  ② 幂等：已被超时/回包处理掉的条目不会被完成第二次（表空时直接返回 0）；
  ///  ③ 返回时表必定为空——残留一条都可能在重连后与新的同号命令撞上。
  int failAll(String reason) {
    if (_items.isEmpty) return 0;
    final entries = _items.entries.toList(growable: false);
    var done = 0;
    for (final e in entries) {
      // 逐条「取走再完成」：其间即使有并发（超时定时器 / 迟到的回包）把该条移走，
      // 也不会出现二次完成（Completer 二次 complete 会抛 StateError）。
      final pending = _items.remove(e.key);
      if (pending == null) continue;
      if (!pending.completer.isCompleted) {
        pending.completer.complete(CmdResult(false, null, reason));
        done += 1;
      }
    }
    _items.clear(); // 兜底：正常路径上面已清空，这里保证「绝不残留」
    return done;
  }
}

/// WebSocket 客户端：连接桌面端远程服务、配对、发命令、收事件。
/// 纯通信层，不持有业务状态（页面各自用 setState 管理）。
class WsClient {
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  int _cmdSeq = 0;
  /// 在途命令登记表。连接一旦不可用就整体立即失败（[PendingCommands.failAll]），
  /// 绝不让调用方白等满 60 秒的超时。
  final PendingCommands _pending = PendingCommands();

  // —— relay 模式（网关中继）自动重连所需状态 ——
  String? _relayUrl;
  String? _relayToken;
  String? _targetDeviceId;
  bool _autoReconnect = false;
  bool _reconnecting = false;
  int _reconnectAttempts = 0;

  /// 连接代数：每次主动新建/切换/重试连接都 +1。旧连接残留的 onDone/onError/message
  /// 回调携带自己的代数，与当前代数不符时一律忽略——否则「用户主动切设备」后，
  /// 被丢弃的旧 channel 关闭事件会再调度一次重连，把新页面又拽回加载态（甚至双连接互踢）。
  int _connSeq = 0;

  /// 可取消的重连定时器。之前用 Future.delayed 调度重连，**无法打断**：
  /// 用户点「切换设备/重试」直接重连后，那个延迟回调仍会在稍后再连一次，造成双连接。
  Timer? _reconnectTimer;

  // —————————————————— 凭证失效（401）状态机 ——————————————————
  //
  // 【改造前的行为】握手 401（会员 JWT 过期）→ 页面用字符串匹配把 error 当「登录已过期」
  // 直接 TokenStore.clear() 踢回登录页；电脑/手机关机过夜后必然要重新输密码。
  // 【现在的行为】401 → 交给 MemberCredentials 先试一次 refresh（网关有 7 天宽限期，多数情况免密续上）
  //  → 成功就带新 token 立即重连；只有 refresh 也确认「凭证不可恢复」才置 authFailed 并要求重登。
  // 【降级可用】网关未部署新错误码时（握手失败读不到 JSON body，见 _handshakeStatus 注释），
  //  任何 401 一律「先试 refresh 一次」，不依赖结构化 code 才工作。

  /// 凭证已确认不可恢复（refresh 也失败）：置 true 后**停止自动重连**，等用户重新登录。
  bool _authFailed = false;
  bool get authFailed => _authFailed;

  /// 失效原因文案（界面如实呈现用，不含 token）
  String? _authReason;
  String? get authReason => _authReason;

  /// 凭证状态流（转发 MemberCredentials，页面据此显示「有效 / 即将到期 / 已失效 / 有效期未知」）
  Stream<CredentialSnapshot> get credentialStatus => MemberCredentials.instance.status;
  CredentialSnapshot get credential => MemberCredentials.instance.snapshot;

  void _emit(String event, [Map<String, dynamic>? payload]) {
    if (_events.isClosed) return;
    _events.add(ServerEvent(event, payload ?? const <String, dynamic>{}));
  }

  /// 握手失败 → 判定是不是「凭证被拒」（401/403）。
  ///
  /// Dart 侧事实（已用本地探针核实）：`WebSocket.connect` 在非 101 升级响应时抛
  /// `WebSocketException(message, httpStatusCode)`，被 web_socket_channel 包成
  /// `WebSocketChannelException`（`inner` 保留原异常）。
  /// **能拿到 HTTP 状态码，但拿不到 401 的 JSON body**（toString 只有
  /// `…was not upgraded to websocket, HTTP status code: 401`），因此网关新下发的结构化错误码
  /// （token_expired / token_missing / token_invalid）在握手阶段读不到 →
  /// 走「任何 401 一律先试一次 refresh」的降级路径，由 refresh 接口自己的响应体来区分错误码。
  static int? _handshakeStatus(Object e) {
    Object? cur = e;
    for (var i = 0; i < 4 && cur != null; i++) {
      try {
        final code = (cur as dynamic).httpStatusCode;
        if (code is int && code > 0) return code;
      } catch (_) {
        // 该层没有 httpStatusCode，继续往下剥
      }
      try {
        cur = (cur as dynamic).inner;
      } catch (_) {
        cur = null;
      }
    }
    final m = RegExp(r'HTTP status code:\s*(\d{3})').firstMatch(e.toString());
    return m == null ? null : int.tryParse(m.group(1)!);
  }

  /// 凭证确认不可恢复的统一收尾：停止自动重连 + 发 auth_expired 事件（页面给重登出口）
  void _failAuth(String reason) {
    _authFailed = true;
    _authReason = reason;
    cancelReconnect();
    _setState(ConnState.disconnected);
    _emit('auth_expired', {'message': reason});
  }

  /// 已建立连接上收到 auth_* 错误码：同样先试续签；成功就带新 token 重连，失败才要求重登。
  Future<void> _onInBandAuthRejected(String code, String message) async {
    final outcome = await MemberCredentials.instance.handleAuthRejected(
      source: 'relay-inband',
      status: 401,
      code: code,
      message: message,
    );
    if (outcome == RefreshOutcome.rotated) {
      _emit('auth_renewed', {'message': _l.wsCredRenewed});
      // 旧连接的凭证已被网关判死，必须换连接；reconnectNow 会清 authFailed 并立即握手
      unawaited(reconnectNow());
      return;
    }
    if (outcome == RefreshOutcome.invalid) {
      // lastError 有值就原样呈现（口径④）；为空才用我们的兜底。
      // 兜底复用 7A 已有的 commonLoginExpiredFallback —— 中文逐字相同，不登记第二份。
      _failAuth(MemberCredentials.instance.snapshot.lastError ?? _l.commonLoginExpiredFallback);
      return;
    }
    // transient：保留登录态，交给连接层退避重连
    _emit('error', {'message': _l.wsRenewPendingInBand(code)});
    _scheduleReconnect();
  }

  ConnState _state = ConnState.disconnected;
  ConnState get state => _state;

  /// 当前指定的目标设备 id（未指定 = 由网关自动配对/返回设备列表）
  String? get targetDeviceId => _targetDeviceId;

  /// 是否具备 relay 重连条件（有网关地址 + token）：启动页据此决定「重试」是否可用
  bool get hasRelaySession => (_relayUrl != null && _relayToken != null);

  final _events = StreamController<ServerEvent>.broadcast();
  Stream<ServerEvent> get events => _events.stream;

  final _stateCtrl = StreamController<ConnState>.broadcast();
  Stream<ConnState> get stateStream => _stateCtrl.stream;

  void _setState(ConnState s) {
    _state = s;
    if (!_stateCtrl.isClosed) _stateCtrl.add(s);
  }

  /// 放弃当前连接（fire-and-forget，绝不 await）：
  /// 握手卡住时 sink.close() 的 Future 永不 resolve，await 会把调用方永久卡死。
  /// 这里只置空引用并异步关闭，忽略结果，保证超时/失败路径能立即继续。
  void _abortChannel() {
    final ch = _channel;
    _channel = null;
    if (ch != null) {
      unawaited(ch.sink.close().catchError((_) {}));
    }
  }

  /// 连接已不可用时，让所有在途命令**立即**失败（文案 = wsCmdConnLost），不再白等 60 秒。
  /// 幂等：表空时什么都不做，可在多个时机（断开/出错/换连接/销毁）重复调用。
  void _failInFlightCommands() {
    _pending.failAll(_l.wsCmdConnLost);
  }

  /// 连接并等待 WebSocket 握手完成（局域网直连模式）
  Future<void> connect(String host, int port) async {
    cancelReconnect();
    _autoReconnect = false; // 局域网模式不自动重连（配对码需用户重新输入）
    final seq = ++_connSeq;
    _setState(ConnState.connecting);
    final uri = Uri.parse('ws://$host:$port');
    // 用 IOWebSocketChannel 并设 pingInterval：底层定期发协议层 ping 帧保活，
    // 对端（局域网 ws server / 网关）协议栈自动回 pong，不进入应用层消息解析。
    _channel = IOWebSocketChannel.connect(
      uri,
      pingInterval: const Duration(seconds: 30),
      connectTimeout: const Duration(seconds: 15),
    );
    try {
      await _channel!.ready;
    } catch (e) {
      // 握手失败/超时：清理连接并抛出，由调用方（ConnectPage）展示错误，避免永久挂起。
      // 注意：不能 await sink.close()——连接握手卡住时 local.stream 监听尚未注册，
      // close 的 Future 永不 resolve，会把这里永久卡死（见 _abortChannel）。
      _abortChannel();
      _setState(ConnState.disconnected);
      rethrow;
    }
    _setState(ConnState.connected);
    _sub = _channel!.stream.listen(
      (raw) => _onMessage(seq, raw),
      onDone: () => _onDone(seq),
      onError: (Object e) => _onError(seq, e),
      cancelOnError: false,
    );
  }

  /// 通过网关中继连接（外网可达）：作为 Client 连网关 bridge，网关按 memberID 自动配对到桌面端 Host。
  /// 网关采用 close-and-reconnect 策略：当 Host 后上线时会主动关闭 pending 的 Client 连接，期望 Client 自动重连。
  /// 因此这里在连接断开后自动重连，直到与桌面端 Host 稳定配对。
  /// [targetDeviceId] 可选：指定要连接的桌面端设备（同账号多设备时，未指定则由网关返回设备列表供选择）。
  Future<void> connectRelay(String url, String token, {String? targetDeviceId}) async {
    _relayUrl = url;
    _relayToken = token;
    _targetDeviceId = targetDeviceId;
    _autoReconnect = true;
    await _doConnectRelay();
  }

  Future<void> _doConnectRelay({bool allowAuthRetry = true}) async {
    // 每次真正发起握手都推进代数，并取消排队中的旧重连：
    // 保证「同一时刻只有一个连接在跑」，旧连接的关闭回调按代数被忽略。
    cancelReconnect();
    final seq = ++_connSeq;
    _setState(ConnState.connecting);
    final url = _relayUrl;
    // 每次握手都从凭证层取「当前最新」token：续签成功后一定用新值，
    // 不会拿页面里缓存的旧 token 反复被网关拒（这是「续签了但还是掉线」的典型成因）。
    final token = MemberCredentials.instance.accessToken ?? _relayToken;
    if (url == null || token == null || token.isEmpty) {
      _failAuth(_l.wsNoCredential);
      throw StateError(_authReason ?? 'no credential');
    }
    _relayToken = token;
    final base = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
    final sep = base.contains('?') ? '&' : '?';
    var query = '${sep}role=client&token=${Uri.encodeComponent(token)}';
    if (_targetDeviceId != null && _targetDeviceId!.isNotEmpty) {
      query += '&targetDeviceId=${Uri.encodeComponent(_targetDeviceId!)}';
    }
    final uri = Uri.parse('$base$query');
    // 用 IOWebSocketChannel 并设 pingInterval：底层定期发协议层 ping 帧保活，
    // 网关协议栈自动回 pong，不进入应用层消息解析，因此不会被误转发、不会触发 host_offline 报错。
    _channel = IOWebSocketChannel.connect(
      uri,
      pingInterval: const Duration(seconds: 30),
      connectTimeout: const Duration(seconds: 15),
    );
    try {
      await _channel!.ready;
    } catch (e) {
      // 握手失败/超时：清理连接，通知 UI 并交给自动重连兜底，同时向上抛出让调用方感知首次失败。
      // 之前这里没 catch，导致「正在恢复登录」永久转圈且不重连（listen 尚未注册，onDone/onError 不会触发）。
      // 更不能 await sink.close()：握手卡住时 close 的 Future 永不 resolve，会把这里永久卡死，
      // 进而使「正在恢复登录」永远不更新（error 事件发不出、rethrow 到不了 _restore 的 catch）。
      _abortChannel();
      _setState(ConnState.disconnected);
      final status = _handshakeStatus(e);
      if (status == 401 || status == 403) {
        // 【401 改造核心】不再「直接停止重连 + 提示登录过期」，先交给凭证层试一次 refresh：
        //   rotated   → 带新 token 立即重连一次（本轮只允许一次，防 refresh↔401 死循环）
        //   invalid   → 才落到「登录已失效，请重新登录」（authFailed + 停重连 + auth_expired 事件）
        //   transient → 网关未部署 / 断网 / 5xx：保留登录态，按连接层退避继续重连，文案如实说明
        final outcome = await MemberCredentials.instance.handleAuthRejected(
          source: 'relay-ws',
          status: status,
          message: e.toString(),
        );
        if (outcome == RefreshOutcome.rotated) {
          if (allowAuthRetry) {
            _emit('auth_renewed', {'message': _l.wsCredRenewed});
            return _doConnectRelay(allowAuthRetry: false);
          }
          _failAuth(MemberCredentials.instance.snapshot.lastError ?? _l.wsRejectedAfterRotation);
          rethrow;
        }
        if (outcome == RefreshOutcome.invalid) {
          _failAuth(MemberCredentials.instance.snapshot.lastError ?? _l.commonLoginExpiredFallback);
          rethrow;
        }
        // 原实现是相邻字符串拼接两行 → 合并成一条整句词条（英文语序不同，拼接会散架）
        _emit('error', {'message': _l.wsExpiredTransient});
        _scheduleReconnect();
        rethrow;
      }
      _emit('error', {'message': _l.wsConnectFailed('$e')});
      _scheduleReconnect();
      rethrow;
    }
    _setState(ConnState.connected);
    _reconnectAttempts = 0; // 连接成功，重置退避计数
    _authFailed = false; // 握手成功即凭证可用，清掉上一轮的失效标记
    _authReason = null;
    _sub = _channel!.stream.listen(
      (raw) => _onMessage(seq, raw),
      onDone: () => _onDone(seq),
      onError: (Object e) => _onError(seq, e),
      cancelOnError: false,
    );
  }

  /// 切换到指定设备：设置 targetDeviceId 后关闭当前连接，并立即重连。
  /// 注意：_sub.cancel() 之后订阅不会再触发 onDone/onError，因此必须显式重连，
  /// 不能依赖「关闭连接触发自动重连」——那是之前「找不到连接对象」的根因。
  /// 另外必须 cancelReconnect() + 重置退避计数：否则上一次排队的重连定时器会在切设备后
  /// 再连一次旧目标，出现双连接被网关互踢、页面被旧回调拽回加载态。
  Future<void> switchDevice(String deviceId) async {
    _targetDeviceId = deviceId;
    cancelReconnect();
    _reconnectAttempts = 0;
    final sub = _sub;
    _sub = null;
    if (sub != null) await sub.cancel();
    _abortChannel();
    // 旧连接被主动废弃（切设备），它上面的在途命令不可能再回来：立即如实失败。
    _failInFlightCommands();
    if (_autoReconnect && _relayUrl != null && _relayToken != null) {
      try {
        await _doConnectRelay();
      } catch (_) {
        // 立即重连失败：回到断开态并交给自动重连兜底
        _setState(ConnState.disconnected);
        _scheduleReconnect();
      }
    }
  }

  /// 用户主动「重试」：打断进行中的重连与旧连接，立即重新握手。
  /// 与 connectRelay 的区别是不改 targetDeviceId（重试当前设备）。
  /// 返回是否握手成功（失败时内部已交给自动重连兜底，调用方只需更新文案）。
  Future<bool> reconnectNow() async {
    if (_relayUrl == null || _relayToken == null) return false;
    cancelReconnect();
    _reconnectAttempts = 0;
    _autoReconnect = true;
    // 用户主动重试 = 明确授权「再给凭证一次机会」：清掉失效标记，让 401 状态机重新走一遍
    // （先 refresh，成功重连；仍不可恢复才再次落回 auth_expired 并停重连）。
    _authFailed = false;
    _authReason = null;
    final sub = _sub;
    _sub = null;
    if (sub != null) await sub.cancel();
    _abortChannel();
    // 用户主动重试 = 旧连接已被放弃，在途命令同样立即失败（避免回退到旧 id 上等 60 秒）。
    _failInFlightCommands();
    try {
      await _doConnectRelay();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 主动尝试一次「续签后重连」（主页/启动页的「重新登录」旁路入口用）。
  /// 与 reconnectNow 的区别：先显式走一次凭证续签，把「网关未部署 / 网络异常」与
  /// 「凭证真的不可恢复」两种结果如实回传给调用方，便于界面给准确文案。
  Future<({RefreshOutcome outcome, bool connected})> renewAndReconnect() async {
    final outcome = await MemberCredentials.instance.refresh('manual');
    final connected = await reconnectNow();
    return (outcome: outcome, connected: connected);
  }

  /// 取消排队中的自动重连（用户主动切设备/重试/退出/跳转时调用）。
  void cancelReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _reconnecting = false;
  }

  void _onMessage(int seq, dynamic raw) {
    // 旧连接的迟到消息：丢弃，避免污染当前连接的状态与页面
    if (seq != _connSeq) return;
    Map<String, dynamic> map;
    try {
      map = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (map['type']) {
      case 'paired':
        _setState(ConnState.paired);
        break;
      case 'connected':
        // 网关在 Client 连接后下发 connected 消息，message 区分配对结果：
        // - "connected to host"：已配对到具体 Host → paired（进入主页）
        // - "connected to relay (host offline)"：Host 离线，仅连上网关 → 保持 connected，等待 Host 上线
        final cmsg = (map['message'] as String?) ?? '';
        if (cmsg.contains('connected to host')) {
          _setState(ConnState.paired);
        } else {
          _setState(ConnState.connected);
          // Host 离线/未上线：通知 UI 展示「桌面端离线」，避免文案卡在「正在恢复登录 / 登录成功连接中」。
          // 之前这里只 setState connected，startup/login 页收不到任何事件，_status 永远停在初始文案，用户以为卡死。
          if (!_events.isClosed) {
            _events.add(ServerEvent('host_offline', {'message': _l.wsHostOfflineWait}));
          }
        }
        break;
      case 'host_disconnected':
        // 网关中继：桌面端 Host 离线。连接仍保留在 pending 队列，Host 上线后网关会关闭连接触发重连，
        // 这里仅通知 UI 展示提示，不主动断开。
        // 网关带回的原文优先原样呈现（口径④），没带回才用我们的兜底
        _events.add(ServerEvent('host_offline', {'message': map['message'] ?? _l.wsHostOffline}));
        break;
      case 'host_connected':
        // 网关中继：Host 已上线，网关随后会关闭本连接触发自动重连进入正常配对流程。
        _events.add(ServerEvent('host_online', {}));
        break;
      case 'devices_list':
        // 网关中继：同账号多设备在线，网关返回设备列表让用户选择。
        final payload = (map['payload'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
        _events.add(ServerEvent('devices_list', {'devices': payload['devices'] ?? const []}));
        break;
      case 'event':
        final payload = (map['payload'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
        _events.add(ServerEvent(map['event'] as String? ?? '', payload));
        break;
      case 'cmd_result':
        final id = map['id'] as int?;
        // take = 取走即移出登记表：同一 id 的迟到重发回包拿到 null，不会二次完成（幂等）。
        final c = id == null ? null : _pending.take(id);
        c?.complete(CmdResult(map['ok'] == true, map['data'], map['error'] as String?));
        break;
      case 'error':
        // 网关在已建立连接上也可能下发带结构化 code 的 error（定稿：auth_failed / token_* ）。
        // 这类消息**不能**当普通网络错误交给页面做「清 token + 回登录页」，
        // 必须走同一套 401 状态机：先试续签，救不回来才发 auth_expired。
        final errCode = (map['code'] ?? map['error_code'] ?? '').toString().trim();
        final errMsg = (map['message'] ?? '').toString();
        if (errCode == 'auth_failed' ||
            errCode == 'token_expired' ||
            errCode == 'token_invalid' ||
            errCode == 'token_missing') {
          unawaited(_onInBandAuthRejected(errCode, errMsg));
          return;
        }
        _emit('error', {'message': errMsg, if (errCode.isNotEmpty) 'code': errCode});
        break;
      default:
        // 网关控制消息（connected / client_connected 等）忽略
        break;
    }
  }

  void _onDone(int seq) {
    // 被主动替换/放弃的旧连接（代数不符）：不置断开态、不调度重连，
    // 否则切设备/重试后旧 channel 的关闭事件会把新页面又拽回加载态。
    if (seq != _connSeq) return;
    _setState(ConnState.disconnected);
    // 连接已关闭：在途命令不可能再拿到结果，立即如实失败，不让调用方白等满 60 秒。
    _failInFlightCommands();
    _scheduleReconnect();
  }

  void _onError(int seq, Object e) {
    if (seq != _connSeq) return;
    // 同上：连接出错即视为不可用，在途命令立即失败。
    _failInFlightCommands();
    if (!_events.isClosed) _events.add(ServerEvent('error', {'message': e.toString()}));
    _scheduleReconnect();
  }

  /// 连接断开后延迟自动重连（仅 relay 模式；局域网模式配对码需用户重新输入，不自动重连）。
  /// 用可取消的 Timer 而非 Future.delayed：用户主动重试/切设备/退出时必须能打断排队中的重连。
  void _scheduleReconnect() {
    // 走到这里 = 连接已经不可用（关闭 / 出错 / 握手失败 / 切设备后重连失败）：
    // 先把在途命令全部立即失败，再决定要不要调度重连。放在三个早返回之前是刻意的——
    // 局域网模式（不自动重连）与凭证失效（不重连）下同样必须失败，否则那些场景里的
    // 在途命令仍要白等满 60 秒。该动作幂等，重复调用无副作用。
    _failInFlightCommands();
    if (!_autoReconnect || _reconnecting) return;
    // 凭证已确认不可恢复（refresh 也失败）：不再空转重连——那只会反复拿同一份废 token 撞 401，
    // 直到用户点「重新登录」/「重试」（reconnectNow 会清掉这个标记）才恢复。
    if (_authFailed) return;
    _reconnecting = true;
    // 指数退避 + 随机抖动：避免多台电脑/设备同步惊群重连、反复触发网关踢连接
    final exp = min(2 * pow(2, _reconnectAttempts), 30).toDouble();
    final jitter = exp * (0.8 + Random().nextDouble() * 0.4); // ±20%
    _reconnectAttempts += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: (jitter * 1000).round()), () {
      _reconnecting = false;
      _reconnectTimer = null;
      if (_autoReconnect && _relayUrl != null && _relayToken != null) {
        // 忽略重连失败（_onError 会再次调度重连）
        _doConnectRelay().catchError((_) {});
      }
    });
  }

  /// 当前是否处于「可以发命令」的连接态（连上网关或已配对）
  bool get _canSend => _channel != null && (_state == ConnState.connected || _state == ConnState.paired);

  /// 发送配对码；未连接时返回 false（局域网页据此提示，而不是静默无反应）
  bool pair(String code) {
    if (!_canSend) return false;
    try {
      _channel!.sink.add(jsonEncode({'type': 'pair', 'code': code}));
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 请求设备列表（网关中继多设备：网关返回 devices_list 事件）。
  /// 返回 false = 当前没连接可发（调用方需给出提示，不能让用户点了按钮毫无反馈）。
  bool listDevices() {
    if (!_canSend) return false;
    try {
      _channel!.sink.add(jsonEncode({'type': 'list_devices'}));
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 查询当前待处理的审批/提问请求（连接后恢复弹窗）。
  /// 审批/提问是一次性广播事件，客户端若错过（切走会话、连接前已发出），
  /// 需主动查询并恢复弹窗，否则工具会一直阻塞等待应答。
  Future<CmdResult> getPendingRequests() {
    return sendCommand('get_pending_requests');
  }

  /// 发送命令，返回结果（带 60 秒兜底超时 + 只读命令的有限重试）。
  /// 未连接时**立即失败返回**：之前把命令写进一个不存在/已关闭的 sink，
  /// 要么 _channel 为 null 时静默不发、白等 60 秒超时，要么对已关闭 sink add 直接抛异常，
  /// 在「已登录但未连上任何桌面端」的场景下会让会话列表转圈一分钟。
  ///
  /// 重试：只有 [idempotentCommands] 里的只读命令会重试（最多 [maxReadOnlyAttempts] 次尝试，
  /// 退避见 [commandRetryBackoff]）；写类命令一次都不重试 —— 重试 = 同一需求跑两遍。
  /// 且只重试「断线 / 没送出去」这类失败；**跑满 60 秒兜底超时的不重试**（见 [shouldRetryFailure]）。
  /// 于是最坏耗时仍是「一次 60 秒」（旧口径下的 3×60s 已消除），且不因此少了一次重试的机会：
  /// 断线那条路径本来就几乎瞬时返回，重试它本来就不占时间。
  Future<CmdResult> sendCommand(String cmd, [Map<String, dynamic>? payload]) {
    return sendCommandWithRetry(cmd, () => _sendCommandOnce(cmd, payload));
  }

  /// 单次发送（不含重试策略）：挂进 [_pending] 等回包，60 秒兜底超时。
  Future<CmdResult> _sendCommandOnce(String cmd, [Map<String, dynamic>? payload]) {
    if (!_canSend) {
      return Future.value(CmdResult(false, null, _l.wsNotConnected));
    }
    final id = ++_cmdSeq;
    final c = Completer<CmdResult>();
    _pending.add(id, cmd, c);
    try {
      _channel!.sink.add(jsonEncode({'type': 'cmd', 'id': id, 'cmd': cmd, 'payload': payload ?? const {}}));
    } catch (e) {
      _pending.take(id);
      return Future.value(CmdResult(false, null, _l.wsSendFailed('$e')));
    }
    return c.future.timeout(const Duration(seconds: 60), onTimeout: () {
      _pending.take(id);
      // timedOut: true —— 让重试判定认出「这是超时，不是断线」，从而不再重发（见 shouldRetryFailure）。
      return CmdResult(false, null, _l.wsCmdTimeout, timedOut: true);
    });
  }

  Future<void> dispose() async {
    _autoReconnect = false; // 主动销毁，停止自动重连
    cancelReconnect();
    _connSeq++; // 让所有在途回调按「旧连接」被忽略
    await _sub?.cancel();
    _sub = null;
    _abortChannel();
    // 销毁即放弃：在途命令立即失败并清表，不留悬挂的 future。
    _failInFlightCommands();
    await _events.close();
    await _stateCtrl.close();
  }
}
