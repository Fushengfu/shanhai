import 'dart:async';
import 'package:flutter/material.dart';
import '../theme.dart';
import '../services/update_service.dart';
import '../services/ws_client.dart';
import '../widgets/device_picker.dart';
import '../widgets/update_dialog.dart';
import 'session_list_page.dart';
import 'supervisor_page.dart';

/// 首页：底部导航切换「会话模式 / 管家模式」，顶部提供「切换设备」入口（同账号多电脑）。
class HomePage extends StatefulWidget {
  final WsClient ws;
  const HomePage({super.key, required this.ws});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;
  bool _hostOffline = false;
  bool _switchingDevice = false;
  bool _checkingUpdate = false;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<ConnState>? _stateSub;

  @override
  void initState() {
    super.initState();
    // 桌面端 Host 离线/上线提示 + 设备列表（切换设备用）
    _eventSub = widget.ws.events.listen((e) {
      if (e.event == 'host_offline') {
        if (mounted && !_hostOffline) setState(() => _hostOffline = true);
      } else if (e.event == 'host_online') {
        if (mounted && _hostOffline) setState(() => _hostOffline = false);
      } else if (e.event == 'devices_list' && mounted) {
        _showDevicePicker(e.payload['devices'] as List? ?? const []);
      }
    });
    // 切换到其他设备并成功配对后，清除「离线」横幅。
    // 之前 _hostOffline 只被 host_online 事件清除，而 switchDevice 配对成功走的是 paired 状态、
    // 不触发 host_online 事件，导致「当前设备掉线后切到其他设备」时横幅仍显示「桌面端离线，等待重新连接…」。
    _stateSub = widget.ws.stateStream.listen((s) {
      if (s == ConnState.paired && mounted && _hostOffline) {
        setState(() => _hostOffline = false);
      }
    });
    // 进入主页后静默检查一次版本更新（有更新才弹窗，无更新不打扰）
    Future.microtask(() => _checkUpdate(silent: true));
  }

  /// 版本检查：silent=true 时无更新不提示；手动触发（按钮）时无论结果都给反馈。
  Future<void> _checkUpdate({bool silent = false}) async {
    if (_checkingUpdate) return;
    _checkingUpdate = true;
    final result = await UpdateService().check();
    _checkingUpdate = false;
    if (!mounted) return;

    if (result.hasUpdate && result.update != null) {
      await showUpdateDialog(context, result.update!);
    } else if (!silent) {
      final msg = result.error ?? '当前已是最新版本';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg, style: const TextStyle(fontSize: 13))),
      );
    }
  }

  /// 请求设备列表后弹出选择器，选中后切换连接目标设备
  void _requestSwitchDevice() {
    widget.ws.listDevices();
  }

  Future<void> _showDevicePicker(List<dynamic> devices) async {
    if (_switchingDevice) return;
    _switchingDevice = true;
    final chosen = await showDevicePickerSheet(context, devices);
    if (chosen != null && chosen.isNotEmpty) {
      await widget.ws.switchDevice(chosen);
    }
    if (mounted) setState(() => _switchingDevice = false);
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _stateSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('山海', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        actions: [
          IconButton(
            tooltip: '检查更新',
            icon: const Icon(Icons.system_update_alt),
            onPressed: () => _checkUpdate(silent: false),
          ),
          // 主题切换入口：跟随系统 / 亮色 / 暗色（与桌面端主题机制对齐）
          ValueListenableBuilder<AppThemeMode>(
            valueListenable: ThemeController.instance,
            builder: (context, mode, _) => PopupMenuButton<AppThemeMode>(
              tooltip: '主题',
              icon: Icon(mode.icon),
              onSelected: (m) => ThemeController.instance.setMode(m),
              itemBuilder: (_) => [
                for (final m in AppThemeMode.values)
                  PopupMenuItem(
                    value: m,
                    child: Row(
                      children: [
                        Icon(m.icon, size: 18),
                        const SizedBox(width: 10),
                        Text(m.label, style: const TextStyle(fontSize: 14)),
                        if (m == mode) ...[
                          const SizedBox(width: 8),
                          const Icon(Icons.check, size: 16, color: Color(0xFF8B5CF6)),
                        ],
                      ],
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            tooltip: '切换设备',
            icon: const Icon(Icons.devices_outlined),
            onPressed: _requestSwitchDevice,
          ),
        ],
      ),
      body: Column(
        children: [
          if (_hostOffline)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: const Color(0xFF7C4A12),
              child: const Row(
                children: [
                  Icon(Icons.cloud_off_outlined, size: 16, color: Color(0xFFFBBF24)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '桌面端离线，等待重新连接…',
                      style: TextStyle(fontSize: 13, color: Color(0xFFFDE68A)),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: [
                SessionListPage(ws: widget.ws),
                SupervisorPage(ws: widget.ws),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: '会话'),
          NavigationDestination(icon: Icon(Icons.supervisor_account_outlined), selectedIcon: Icon(Icons.supervisor_account), label: '管家'),
        ],
      ),
    );
  }
}
