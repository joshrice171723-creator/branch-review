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
