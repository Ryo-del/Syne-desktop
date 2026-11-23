; Установщик Tauri сам закрывает только главный exe приложения. Sidecar
; syne-desktop-api.exe держит свой файл открытым, и без этого хука обновление
; падает с "Error opening file for writing ... syne-desktop-api.exe".
!macro KillSyneDesktopApi
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "syne-desktop-api.exe"
  !else
    nsis_tauri_utils::KillProcess "syne-desktop-api.exe"
  !endif
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillSyneDesktopApi
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillSyneDesktopApi
!macroend
