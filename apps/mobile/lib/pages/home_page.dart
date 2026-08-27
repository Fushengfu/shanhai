import 'dart:async';
import 'package:flutter/material.dart';
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
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('山海', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        backgroundColor: const Color(0xFF16161F),
        foregroundColor: Colors.white,
        elevation: 0,
        actions: [
          IconButton(
            tooltip: '检查更新',
            icon: const Icon(Icons.system_update_alt),
            onPressed: () => _checkUpdate(silent: false),
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
        backgroundColor: const Color(0xFF16161F),
        indicatorColor: const Color(0xFF2A2A3A),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: '会话'),
          NavigationDestination(icon: Icon(Icons.supervisor_account_outlined), selectedIcon: Icon(Icons.supervisor_account), label: '管家'),
        ],
      ),
    );
  }
}
