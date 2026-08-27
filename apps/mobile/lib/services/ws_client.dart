import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// 连接状态
enum ConnState { disconnected, connecting, connected, paired }

/// 服务端推送的事件
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
  CmdResult(this.ok, this.data, this.error);
}

/// WebSocket 客户端：连接桌面端远程服务、配对、发命令、收事件。
/// 纯通信层，不持有业务状态（页面各自用 setState 管理）。
class WsClient {
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  int _cmdSeq = 0;
  final Map<int, Completer<CmdResult>> _pending = {};

  // —— relay 模式（网关中继）自动重连所需状态 ——
  String? _relayUrl;
  String? _relayToken;
  String? _targetDeviceId;
  bool _autoReconnect = false;
  bool _reconnecting = false;
  int _reconnectAttempts = 0;

  ConnState _state = ConnState.disconnected;
  ConnState get state => _state;

  final _events = StreamController<ServerEvent>.broadcast();
  Stream<ServerEvent> get events => _events.stream;

  final _stateCtrl = StreamController<ConnState>.broadcast();
  Stream<ConnState> get stateStream => _stateCtrl.stream;

  void _setState(ConnState s) {
    _state = s;
    if (!_stateCtrl.isClosed) _stateCtrl.add(s);
  }

  /// 连接并等待 WebSocket 握手完成
  Future<void> connect(String host, int port) async {
    _setState(ConnState.connecting);
    final uri = Uri.parse('ws://$host:$port');
    // 用 IOWebSocketChannel 并设 pingInterval：底层定期发协议层 ping 帧保活，
    // 对端（局域网 ws server / 网关）协议栈自动回 pong，不进入应用层消息解析。
    _channel = IOWebSocketChannel.connect(uri, pingInterval: const Duration(seconds: 30));
    try {
      await _channel!.ready.timeout(const Duration(seconds: 15));
    } catch (e) {
      // 握手失败/超时：清理连接并抛出，由调用方（ConnectPage）展示错误，避免永久挂起
      await _channel?.sink.close();
      _channel = null;
      _setState(ConnState.disconnected);
      rethrow;
    }
    _setState(ConnState.connected);
    _sub = _channel!.stream.listen(
      _onMessage,
      onDone: _onDone,
      onError: _onError,
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

  Future<void> _doConnectRelay() async {
    _setState(ConnState.connecting);
    final url = _relayUrl!;
    final token = _relayToken!;
    final base = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
    final sep = base.contains('?') ? '&' : '?';
    var query = '${sep}role=client&token=${Uri.encodeComponent(token)}';
    if (_targetDeviceId != null && _targetDeviceId!.isNotEmpty) {
      query += '&targetDeviceId=${Uri.encodeComponent(_targetDeviceId!)}';
    }
    final uri = Uri.parse('$base$query');
    // 用 IOWebSocketChannel 并设 pingInterval：底层定期发协议层 ping 帧保活，
    // 网关协议栈自动回 pong，不进入应用层消息解析，因此不会被误转发、不会触发 host_offline 报错。
    _channel = IOWebSocketChannel.connect(uri, pingInterval: const Duration(seconds: 30));
    try {
      await _channel!.ready.timeout(const Duration(seconds: 15));
    } catch (e) {
      // 握手失败/超时：清理连接，通知 UI 并交给自动重连兜底，同时向上抛出让调用方感知首次失败。
      // 之前这里没 catch，导致「正在恢复登录」永久转圈且不重连（listen 尚未注册，onDone/onError 不会触发）。
      await _channel?.sink.close();
      _channel = null;
      _setState(ConnState.disconnected);
      if (!_events.isClosed) {
        _events.add(ServerEvent('error', {'message': '连接网关失败：$e'}));
      }
      _scheduleReconnect();
      rethrow;
    }
    _setState(ConnState.connected);
    _reconnectAttempts = 0; // 连接成功，重置退避计数
    _sub = _channel!.stream.listen(
      _onMessage,
      onDone: _onDone,
      onError: _onError,
      cancelOnError: false,
    );
  }

  /// 切换到指定设备：设置 targetDeviceId 后关闭当前连接，并立即重连。
  /// 注意：_sub.cancel() 之后订阅不会再触发 onDone/onError，因此必须显式重连，
  /// 不能依赖「关闭连接触发自动重连」——那是之前「找不到连接对象」的根因。
  Future<void> switchDevice(String deviceId) async {
    _targetDeviceId = deviceId;
    await _sub?.cancel();
    _sub = null;
    await _channel?.sink.close();
    _channel = null;
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

  void _onMessage(dynamic raw) {
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
        }
        break;
      case 'host_disconnected':
        // 网关中继：桌面端 Host 离线。连接仍保留在 pending 队列，Host 上线后网关会关闭连接触发重连，
        // 这里仅通知 UI 展示提示，不主动断开。
        _events.add(ServerEvent('host_offline', {'message': map['message'] ?? '桌面端离线'}));
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
        final c = _pending.remove(id);
        c?.complete(CmdResult(map['ok'] == true, map['data'], map['error'] as String?));
        break;
      case 'error':
        _events.add(ServerEvent('error', {'message': map['message'] ?? ''}));
        break;
      default:
        // 网关控制消息（connected / client_connected 等）忽略
        break;
    }
  }

  void _onDone() {
    _setState(ConnState.disconnected);
    _scheduleReconnect();
  }

  void _onError(Object e) {
    if (!_events.isClosed) _events.add(ServerEvent('error', {'message': e.toString()}));
    _scheduleReconnect();
  }

  /// 连接断开后延迟自动重连（仅 relay 模式；局域网模式配对码需用户重新输入，不自动重连）
  void _scheduleReconnect() {
    if (!_autoReconnect || _reconnecting) return;
    _reconnecting = true;
    // 指数退避 + 随机抖动：避免多台电脑/设备同步惊群重连、反复触发网关踢连接
    final exp = min(2 * pow(2, _reconnectAttempts), 30).toDouble();
    final jitter = exp * (0.8 + Random().nextDouble() * 0.4); // ±20%
    _reconnectAttempts += 1;
    Future<void>.delayed(Duration(milliseconds: (jitter * 1000).round()), () {
      _reconnecting = false;
      if (_autoReconnect && _relayUrl != null && _relayToken != null) {
        // 忽略重连失败（_onError 会再次调度重连）
        _doConnectRelay().catchError((_) {});
      }
    });
  }

  /// 发送配对码
  void pair(String code) {
    _channel?.sink.add(jsonEncode({'type': 'pair', 'code': code}));
  }

  /// 请求设备列表（网关中继多设备：网关返回 devices_list 事件）
  void listDevices() {
    _channel?.sink.add(jsonEncode({'type': 'list_devices'}));
  }

  /// 查询当前待处理的审批/提问请求（连接后恢复弹窗）。
  /// 审批/提问是一次性广播事件，客户端若错过（切走会话、连接前已发出），
  /// 需主动查询并恢复弹窗，否则工具会一直阻塞等待应答。
  Future<CmdResult> getPendingRequests() {
    return sendCommand('get_pending_requests');
  }

  /// 发送命令，返回结果（带超时兜底）
  Future<CmdResult> sendCommand(String cmd, [Map<String, dynamic>? payload]) {
    final id = ++_cmdSeq;
    final c = Completer<CmdResult>();
    _pending[id] = c;
    _channel?.sink.add(jsonEncode({'type': 'cmd', 'id': id, 'cmd': cmd, 'payload': payload ?? const {}}));
    return c.future.timeout(const Duration(seconds: 60), onTimeout: () {
      _pending.remove(id);
      return CmdResult(false, null, '命令超时');
    });
  }

  Future<void> dispose() async {
    _autoReconnect = false; // 主动销毁，停止自动重连
    await _sub?.cancel();
    await _channel?.sink.close();
    await _events.close();
    await _stateCtrl.close();
  }
}
