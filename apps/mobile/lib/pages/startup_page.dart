import 'dart:async';
import 'package:flutter/material.dart';
import '../services/token_store.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import 'home_page.dart';
import 'login_page.dart';

/// 启动分流页：读本地缓存 token——有则自动连网关进主页，无则进登录页。
/// 解决「每次打开都要重新登录」：登录成功后 token 已用 TokenStore 持久化，这里启动时读取并自动恢复会话。
class StartupPage extends StatefulWidget {
  const StartupPage({super.key});

  @override
  State<StartupPage> createState() => _StartupPageState();
}

class _StartupPageState extends State<StartupPage> {
  final _ws = WsClient();
  String _status = '正在恢复登录…';
  bool _pendingDeviceChoice = false;
  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<ServerEvent>? _eventSub;

  @override
  void initState() {
    super.initState();
    _stateSub = _ws.stateStream.listen((s) {
      // 只有真正配对到具体 Host（paired）才进主页；connected 仅表示连上了网关，
      // 可能还处于「Host 离线」或「多设备待选」状态，此时不能进主页（否则 devices_list 会在跳转竞态中丢失）。
      if (s == ConnState.paired) _maybeGoHome();
    });
    _eventSub = _ws.events.listen((e) {
      if (e.event == 'error' && mounted) {
        final msg = e.payload['message']?.toString() ?? '';
        // token 失效/过期：清缓存登录态并回登录页（与普通网络错误区分开）
        if (_isTokenInvalid(msg)) {
          TokenStore.clear();
          _goLogin();
          return;
        }
        // 普通网络错误交给 ws 自动重连，这里仅展示状态
        if (mounted) setState(() => _status = msg);
      } else if (e.event == 'devices_list' && mounted) {
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      } else if (e.event == 'host_offline' && mounted) {
        setState(() => _status = '桌面端离线，等待重新连接…');
      }
    });
    _restore();
  }

  /// 配对成功且当前未在选设备时，进入主页。
  void _maybeGoHome() {
    if (mounted && !_pendingDeviceChoice && _ws.state == ConnState.paired) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomePage(ws: _ws)),
      );
    }
  }

  Future<void> _restore() async {
    String? token;
    try {
      token = await TokenStore.readToken();
    } catch (e) {
      // 读本地登录态失败（如 Keystore 异常）：不能让它悄悄吞掉导致永久转圈。
      debugPrint('[startup] readToken 失败: $e');
      if (mounted) {
        setState(() => _status = '读取登录态失败：$e');
      }
      // 登录态已不可用，清理后回登录页让用户重新登录
      try {
        await TokenStore.clear();
      } catch (_) {}
      _goLogin();
      return;
    }
    debugPrint('[startup] readToken 完成: ${token == null ? 'null' : '长度=${token.length}'}');
    if (token == null || token.isEmpty) {
      _goLogin();
      return;
    }
    // 有缓存 token：自动连网关。失效/失败在事件监听里处理；
    // 这里 catch 首次连接异常，避免「正在恢复登录」永久转圈。
    try {
      debugPrint('[startup] 开始 connectRelay url=$kRelayUrl');
      await _ws.connectRelay(kRelayUrl, token);
      debugPrint('[startup] connectRelay 返回');
    } catch (e) {
      debugPrint('[startup] connectRelay 异常: $e');
      // ws 内部已触发自动重连并发出 error 事件，这里仅兜底更新状态文案
      if (mounted) {
        setState(() => _status = '连接网关失败，正在自动重试…');
      }
    }
  }

  /// 同账号多设备在线：弹设备选择器，选中的设备作为 targetDeviceId 重连（与登录页逻辑一致）。
  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_pendingDeviceChoice) return;
    setState(() {
      _pendingDeviceChoice = true;
      _status = '检测到多台桌面端设备，请选择要连接的设备';
    });
    final chosen = await showDevicePickerSheet(context, devices);
    if (chosen == null) {
      if (mounted) setState(() => _pendingDeviceChoice = false);
      return;
    }
    if (!mounted) return;
    setState(() => _status = '正在连接所选设备…');
    await _ws.switchDevice(chosen);
    if (mounted) setState(() => _pendingDeviceChoice = false);
    // switchDevice 内部重连后，网关的 connected("connected to host") 可能先于 _pendingDeviceChoice 复位到达，
    // 导致 paired 事件已过、跳转被跳过；这里补一次判断。
    if (mounted) _maybeGoHome();
  }

  void _goLogin() {
    // 停止自动重连，避免跳转后孤儿连接继续反复连网关
    _ws.dispose();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginPage()),
    );
  }

  /// 判断网关 error 消息是否为「登录态失效」：含 token 过期/无效/未授权/401 关键字。
  static bool _isTokenInvalid(String msg) {
    final m = msg.toLowerCase();
    return m.contains('invalid token') ||
        m.contains('expired') ||
        m.contains('unauthorized') ||
        m.contains('401');
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    _eventSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                _status,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: Colors.grey),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
