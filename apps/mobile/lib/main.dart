import 'package:flutter/material.dart';
import 'pages/startup_page.dart';

void main() {
  runApp(const ShanhaiMobileApp());
}

class ShanhaiMobileApp extends StatelessWidget {
  const ShanhaiMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '山海',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0E0E14),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF8B5CF6),
          secondary: Color(0xFF22D3EE),
          surface: Color(0xFF16161F),
        ),
        useMaterial3: true,
      ),
      home: const StartupPage(),
    );
  }
}
