Var BRProgressFile
Var BRProgressHandle
Var BRProgressLine
Var BRProgressSavedErrors
Var BRProgressCallback
Var BRProgressCompleted
Var BRProgressTotal
Var BRProgressTick
Var BRProgressLastTick
Var BRProgressDelay
Var BRApplyStatus

Function BranchReviewWriteProgress
  StrCmp $BRProgressFile "" done
  StrCpy $BRProgressSavedErrors 0
  IfErrors 0 write
  StrCpy $BRProgressSavedErrors 1
write:
  ClearErrors
  FileOpen $BRProgressHandle "$BRProgressFile" a
  IfErrors restore
  FileSeek $BRProgressHandle 0 END
  IfErrors close
  FileWrite $BRProgressHandle "$BRProgressLine$\r$\n"
close:
  FileClose $BRProgressHandle
restore:
  ClearErrors
  StrCmp $BRProgressSavedErrors 0 done
  SetErrors
done:
FunctionEnd

Function BranchReviewInitProgress
  ReadEnvStr $BRProgressFile "BRANCH_REVIEW_INSTALL_PROGRESS"
  IfFileExists "$BRProgressFile" report
  StrCpy $BRProgressFile ""
  ClearErrors
  Return
report:
  StrCpy $BRProgressLine "prepare"
  Call BranchReviewWriteProgress
  ClearErrors
FunctionEnd

Function BranchReviewReportExtraction
  Pop $BRProgressCompleted
  Pop $BRProgressTotal
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $BRProgressTick
  StrCmp $BRProgressCompleted $BRProgressTotal report
  StrCmp $BRProgressLastTick "" report
  IntOp $BRProgressDelay $BRProgressTick - $BRProgressLastTick
  IntCmp $BRProgressDelay 250 report done report
report:
  StrCpy $BRProgressLastTick $BRProgressTick
  StrCpy $BRProgressLine "unpack|$BRProgressCompleted|$BRProgressTotal"
  Call BranchReviewWriteProgress
done:
FunctionEnd

!macro BranchReviewExtract FILE
  ${If} $BRProgressFile == ""
    Nsis7z::Extract "${FILE}"
  ${Else}
    GetFunctionAddress $BRProgressCallback BranchReviewReportExtraction
    Nsis7z::ExtractWithCallback "${FILE}" $BRProgressCallback
  ${EndIf}
!macroend

Function BranchReviewApplyFiles
  IfFileExists "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" copy
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
  Goto failed

copy:
  StrCpy $BRProgressLine "apply"
  Call BranchReviewWriteProgress
  # Copy every staged file without purging extra destination files.
  nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$PLUGINSDIR\7z-out" "$OUTDIR\." /E /MT:8 /R:4 /W:1 /IS /IT /XJ /NJH /NJS /NFL /NDL /NP'
  Pop $BRApplyStatus
  ${If} $BRApplyStatus == "error"
  ${OrIf} $BRApplyStatus < 0
  ${OrIf} $BRApplyStatus >= 8
    DetailPrint "Could not copy the application files. Robocopy returned $BRApplyStatus."
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Could not copy the application files." /SD IDCANCEL IDRETRY copy
    Goto failed
  ${EndIf}
  ClearErrors
  Return

failed:
  SetErrorLevel 2
  Quit
FunctionEnd
