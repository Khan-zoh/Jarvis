# Custom NSIS hooks for the Jarvis installer (referenced by electron-builder.yml nsis.include).
#
# Autostart cleanup: when the user enables "launch on startup", the running app registers itself via
# Electron's app.setLoginItemSettings(), which writes a per-user HKCU Run value named after the app
# (productName -> "Jarvis") pointing at the installed exe with the --hidden flag. The installer never
# creates this value, so electron-builder's default uninstaller would leave it dangling after the exe
# is gone. Delete it on uninstall so no broken autostart entry survives.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Jarvis"
!macroend
