; Claude Orchestrator Windows Installer
; Requires Inno Setup 6.x — https://jrsoftware.org/isinfo.php
; Build with: ISCC.exe setup.iss  (or use build.ps1)

#define AppName "Claude Orchestrator"
#define AppVersion "1.1.0"
#define AppPublisher "Pedro Hadek"
#define AppURL "https://github.com/phahadek/claude-orchestrator"

[Setup]
AppId={{7D5ECBA2-8C14-4F3A-B6D9-1E2F305A7891}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\Claude Orchestrator
DefaultGroupName={#AppName}
AllowNoIcons=yes
; Unsigned in v1 — SmartScreen warning expected
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=claude-orchestrator-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Windows x64 only
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Bundled Node 20 LTS x64 runtime
Source: "payload\node.exe"; DestDir: "{app}"; Flags: ignoreversion
; Application dist and node_modules
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
; Launcher
Source: "payload\start.bat"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Data directory — created once; never removed by uninstaller by default
Name: "{userappdata}\ClaudeOrchestrator"

[Icons]
; Start Menu
Name: "{group}\{#AppName}"; Filename: "{app}\start.bat"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
; Desktop (optional task)
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\start.bat"; Tasks: desktopicon
; Startup folder — auto-start for all users (per-machine install)
Name: "{commonstartup}\{#AppName}"; Filename: "{app}\start.bat"

[Run]
; Offer to launch after install
Filename: "{app}\start.bat"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent shellexec
; Offer to open dashboard in browser (server may need a moment to start)
Filename: "http://localhost:3000"; Description: "Open dashboard in browser"; Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; Remove the Startup shortcut explicitly (common startup)
Filename: "{cmd}"; Parameters: "/c del ""{commonstartup}\{#AppName}.lnk"""; Flags: runhidden

[Code]
var
  DeleteDataDirCheckbox: TNewCheckBox;

// Add a "delete data dir" checkbox to the uninstall progress form.
procedure InitializeUninstallProgressForm();
begin
  DeleteDataDirCheckbox := TNewCheckBox.Create(UninstallProgressForm);
  DeleteDataDirCheckbox.Parent := UninstallProgressForm;
  DeleteDataDirCheckbox.Left := ScaleX(8);
  DeleteDataDirCheckbox.Top := UninstallProgressForm.ClientHeight - ScaleY(48);
  DeleteDataDirCheckbox.Width := ScaleX(520);
  DeleteDataDirCheckbox.Height := ScaleY(20);
  DeleteDataDirCheckbox.Caption :=
    'Also delete application data (%APPDATA%\ClaudeOrchestrator)';
  DeleteDataDirCheckbox.Checked := False;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if Assigned(DeleteDataDirCheckbox) and DeleteDataDirCheckbox.Checked then
      DelTree(ExpandConstant('{userappdata}\ClaudeOrchestrator'), True, True, True);
  end;
end;
