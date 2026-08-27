import 'package:flutter/material.dart';

/// 弹出设备选择器（底部弹层），返回选中的 deviceId；用户取消返回 null。
Future<String?> showDevicePickerSheet(BuildContext context, List<dynamic> devices) {
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: const Color(0xFF1A1A24),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => _DevicePickerSheet(devices: devices),
  );
}

/// 设备选择器底部弹层：列出同账号下在线的桌面端设备，点选后返回 deviceId。
class _DevicePickerSheet extends StatelessWidget {
  final List<dynamic> devices;
  const _DevicePickerSheet({required this.devices});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('选择要连接的桌面端设备', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('检测到多台设备在线，请选择一台', style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
            const SizedBox(height: 16),
            ...devices.map((d) {
              final m = (d as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
              final id = m['deviceId']?.toString() ?? '';
              final name = m['deviceName']?.toString() ?? '未命名设备';
              final hostname = m['hostname']?.toString() ?? '';
              final os = m['os']?.toString() ?? '';
              final clientCount = m['clientCount'] ?? 0;
              return ListTile(
                onTap: () => Navigator.of(context).pop(id),
                leading: const Icon(Icons.computer_outlined, size: 18),
                title: Text(name, style: const TextStyle(fontSize: 14)),
                subtitle: Text([hostname, os, '已连接 $clientCount 台手机'].where((s) => s.isNotEmpty).join(' · '), style: const TextStyle(fontSize: 12)),
                trailing: const Icon(Icons.chevron_right, size: 18),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                tileColor: const Color(0xFF22222E),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              );
            }),
          ],
        ),
      ),
    );
  }
}
