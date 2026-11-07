; AGMessage's installer (docs/INSTALL.md), an EXE built by Inno Setup 7.1 from the portable zip's stage without its two .bat
; files (installer/build-installer.ps1). It installs per machine into Program Files\AGMessage, and every machine-level act is
; one of app\machine.js's commands, run elevated with the node.exe this build lays down: the machine folder made race-free
; (prepare), whose AGMessage it is (whose), the checks (preinstall-check, upgrade-stop), the server task, the rules and the
; record (install), the portable import before the first start (import, with launch.js export and forget-keys run as the
; account that started Setup), the start and its verify (start), the first admin account (first-account), the way back
; (restore, then the kept installer of the earlier build with /ROLLBACK) and the uninstall (uninstall). Nothing is written
; to the registry or the machine folder here: the record is machine.js's alone, and so are the folders.
;
; The build passes, from a numbered build only:
;   SemVer          the product's version, MAJOR.MINOR.PATCH                                0.6.0
;   Full            the build as lib/version.js composes it, the one /api/health names     0.6.0+41.abc1234
;   InstallVersion  the install version, MAJOR.MINOR.BUILD (orders installs and upgrades)    0.6.41
;   FileVersion     Windows' four parts, MAJOR.MINOR.PATCH.BUILD                            0.6.0.41
;   Build           the build number                                                       41
;   Label           the file's label, as the zip's (a release's version; a CI build's)     0.6.0, 0.6.0-dev.41_abc1234
;   Payload         the folder of files to lay down (the zip's stage, without its .bat files)
;   OutputDir       where the installer is written
;
; The switches a quiet install takes: /VERYSILENT (Inno's own), /ADMIN=<account> (whose it is, which a quiet first install
; must name), /PUBLICFIREWALL=1 (the rules on Public networks too; =0 takes them off), /FORCE="<reason>" (a busy AGMessage
; stopped anyway, the reason kept in its audit log; a stop with no save record or no backup gone on with), /ROLLBACK (the
; way back: accepted only for the build the install record names as Previous, or for the build it still names when the
; files in Program Files\AGMessage are another build's that never recorded itself, and only while nothing answers on the
; port), and /REMOVEDATA for the uninstaller (every AGMessage data folder removed, the keys last).

#ifndef InstallVersion
  #error An installer is made from a numbered build only (tools/stamp-build.js in CI): a local build has no install version, so it could not be upgraded in order.
#endif

[Setup]
; One AppId for every build: an upgrade is the same application, and a downgrade is refused by its version.
AppId={{D12B473C-134C-49D6-A3C5-F8B3ED738243}
AppName=AGMessage
AppVersion={#InstallVersion}
AppVerName=AGMessage {#SemVer} (build {#Build})
AppPublisher=jammin808
AppCopyright=Copyright 2026 jammin808
VersionInfoVersion={#FileVersion}
VersionInfoProductVersion={#FileVersion}
VersionInfoProductTextVersion={#Full}
VersionInfoDescription=AGMessage {#SemVer} (build {#Build}) installer
; Program Files\AGMessage only: SYSTEM's control tasks and the server task run node.exe from here, and a folder an ordinary
; account may change would let it replace what they run. The folder page is never shown, and PrepareToInstall refuses any
; other folder, /DIR= included.
DefaultDirName={autopf}\AGMessage
DisableDirPage=yes
UsePreviousAppDir=no
DefaultGroupName=AGMessage
DisableProgramGroupPage=yes
; Per machine, by an administrator: an installer that registers tasks and firewall rules has no per-user form, so
; PrivilegesRequiredOverridesAllowed is never given.
PrivilegesRequired=admin
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=AGMessage-Setup-{#Label}-unsigned
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes
; Inno never closes a running AGMessage on its own: the server is stopped only by machine.js, at loopback, where it saves.
CloseApplications=no
RestartApplications=no
UninstallDisplayName=AGMessage {#SemVer} (build {#Build})
UninstallDisplayIcon={app}\node\node.exe

[Files]
; The checks before anything is laid down run on a temporary copy of this build's node.exe and machine.js (the Windows
; readings' R10 read node.exe's extraction inside 5 s): machine.js requires Node's built-ins only, so the two are all it needs.
Source: "{#Payload}\node\node.exe"; Flags: dontcopy
Source: "{#Payload}\app\machine.js"; Flags: dontcopy
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; This installer, kept for the way back by its install version (two are kept; KeepTwoInstallers removes the rest). The kept
; installer of the earlier build, run with /ROLLBACK, never copies itself over itself.
Source: "{srcexe}"; DestDir: "{app}\installers"; DestName: "AGMessage-Setup-{#InstallVersion}-unsigned.exe"; Flags: external ignoreversion; Check: KeepThisInstaller

; No [Dirs] and no [Registry]: the machine folder under %ProgramData%\AGMessage is machine.js prepare's to make, in its order
; (a folder made here, elevated and before that order, would be made through a junction a standard account put there first),
; and HKLM\SOFTWARE\AGMessage is machine.js install's one record.

[Icons]
; Each item is node.exe on launch.js, a console run as the person who chose it and never elevated by itself; launch.js reads
; no machine path from its environment, so each folder is passed here.
Name: "{group}\Open AGMessage"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" open --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Opens AGMessage in your browser, or says what it found"
Name: "{group}\Show the admin token"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" token --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Shows AGMessage's admin token to its admin on this PC"
Name: "{group}\Start AGMessage"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" start --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Starts AGMessage, for its admin on this PC and the accounts it gives start"
Name: "{group}\Stop AGMessage..."; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" stop --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Stops AGMessage, saved, for its admin on this PC and the accounts it gives stop"
Name: "{group}\Who may run AGMessage..."; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" rights --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Lists who may run AGMessage on this PC; its admin gives, takes back or hands over the rights"
Name: "{group}\AGMessage status"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\launch.js"" status --machine ""{commonappdata}\AGMessage"" --sys ""{sys}"""; WorkingDir: "{app}\app"; Comment: "Says how AGMessage runs on this PC"

[Code]
const
  RecordKey = 'SOFTWARE\AGMessage';
  DefaultPort = 3023;
  CP_UTF8 = 65001;
  SacEvaluating = 2;
  SacWords = 'Smart App Control is evaluating this PC. Once it turns itself on, Windows blocks unsigned programs: this installer, its uninstaller and the next AGMessage installer would no longer run. To keep installing and upgrading AGMessage here, turn Smart App Control off in Windows Security > App & browser control > Smart App Control.';
  QuietAdminWords = 'AGMessage needs to know whose it is: add /ADMIN=<account>.';
  AdminRole = 'AGMessage''s admin on this PC is one Windows account, standard or administrator: it reads AGMessage''s admin token (Start > AGMessage > Show the admin token), with which it signs in at the laptop and makes the first admin account; it starts and stops AGMessage (Start AGMessage, Stop AGMessage...), and gives these rights to other accounts, takes them back or hands its admin over (Who may run AGMessage...). Windows asks an administrator''s approval again only to upgrade or uninstall AGMessage.';
  PublicWords = 'AGMessage answers phones, tablets and screens on this PC''s local subnet only, on Private and Domain networks. Windows makes every new network Public, so on fresh venue Wi-Fi nobody reaches AGMessage unless this is ticked, or that network is made Private in Windows'' settings.';
  AccountWords = 'AGMessage has no accounts yet. Make its first admin account now, to sign in with on AGMessage''s page; or leave these empty and make it later at Admin login on this PC, with the token (Start > AGMessage > Show the admin token).';
  ImportWords = 'Before AGMessage first starts, it can take in a portable AGMessage folder''s halls, messages, accounts, screens and keys, so its guests, invites, pins and trusted devices hold. It takes only a folder last run by this same build: upgrade the portable folder first, start it once and stop it. It copies and never moves, then checks what it copied. Once that check passes, the old copies of its keys are removed from your Windows account (%LOCALAPPDATA%\AGMessage, which every portable AGMessage folder of this account uses) and from the folder (app\data\secret.key), and the folder is marked as moved: it no longer starts. Once AGMessage has started, no portable folder can be brought here.';
  ImportHow = 'Stop the portable copy first (Ctrl+C in its window). The folder is read as your Windows account, whose profile holds its keys, and nothing in it changes until what was copied has been checked.';

var
  MachineDir, NodeExe, MachineJs, OneTimeDir: String;
  Installed, Rollback, PublicRecorded: Boolean;
  InstalledVersion, InstalledSemVer, PreviousVersion: String;
  Port: Integer;
  AdminSid, AdminName, WhoseWords: String;
  AdminAgreed: Boolean;
  ChoiceCount: Integer;
  Choice1Sid, Choice1Name, Choice2Sid, Choice2Name: String;
  Force, Backup: String;
  SacPage, AdminPage: TOutputMsgWizardPage;
  AdminChoicePage, PublicPage: TInputOptionWizardPage;
  BusyPage, AccountPage: TInputQueryWizardPage;
  EarlierStopped, ReachedPostInstall, SetupFailed, NeedsAccount: Boolean;
  StartedSid: String;
  ImportChoicePage: TInputOptionWizardPage;
  ImportDirPage: TInputDirWizardPage;
  StartDeferred, ImportFinished, ImportOpen: Boolean;

function MultiByteToWideChar(CodePage, Flags: Cardinal; Source: AnsiString; SourceLength: Integer; Target: String; TargetLength: Integer): Integer;
  external 'MultiByteToWideChar@kernel32.dll stdcall';

// A file read as UTF-8, as machine.js writes its --out: '' when it cannot be read.
function Utf8File(const FileName: String): String;
var
  Bytes: AnsiString;
  N: Integer;
begin
  Result := '';
  if not LoadStringFromFile(FileName, Bytes) then Exit;
  if Length(Bytes) = 0 then Exit;
  N := MultiByteToWideChar(CP_UTF8, 0, Bytes, Length(Bytes), Result, 0);
  if N <= 0 then Exit;
  SetLength(Result, N);
  MultiByteToWideChar(CP_UTF8, 0, Bytes, Length(Bytes), Result, N);
end;

// The place just after "Key": in a record machine.js wrote (its keys are its own and each once), or 0.
function JsonAt(const Json, Key: String): Integer;
var
  P: Integer;
begin
  P := Pos('"' + Key + '":', Json);
  if P = 0 then Result := 0 else Result := P + Length(Key) + 3;
end;

// A string of the record ('' when it has none), JSON's escapes read back: a line end kept, a control character a space.
function JsonText(const Json, Key: String): String;
var
  I: Integer;
  C: String;
begin
  Result := '';
  I := JsonAt(Json, Key);
  if (I = 0) or (I > Length(Json)) then Exit;
  if Json[I] <> '"' then Exit;
  I := I + 1;
  while I <= Length(Json) do
  begin
    C := Json[I];
    if C = '"' then Exit;
    if (C = '\') and (I < Length(Json)) then
    begin
      I := I + 1;
      C := Json[I];
      if C = 'n' then C := #13#10
      else if (C = 'r') or (C = 'b') or (C = 'f') then C := ''
      else if C = 't' then C := ' '
      else if C = 'u' then
      begin
        C := ' ';
        I := I + 4;
      end;
    end;
    Result := Result + C;
    I := I + 1;
  end;
end;

function JsonTrue(const Json, Key: String): Boolean;
begin
  Result := Pos('"' + Key + '":true', Json) > 0;
end;

function JsonInt(const Json, Key: String): Integer;
var
  I, J: Integer;
begin
  Result := 0;
  I := JsonAt(Json, Key);
  if I = 0 then Exit;
  J := I;
  while (J <= Length(Json)) and (Json[J] >= '0') and (Json[J] <= '9') do J := J + 1;
  Result := StrToIntDef(Copy(Json, I, J - I), 0);
end;

// One argument as Windows reads a command line (CommandLineToArgvW): in quotes, a quote inside it escaped, and the
// backslashes before a quote or the end doubled.
function Arg(const S: String): String;
var
  I, Slashes: Integer;
begin
  Result := '"';
  Slashes := 0;
  for I := 1 to Length(S) do
  begin
    if S[I] = '\' then
      Slashes := Slashes + 1
    else
    begin
      if S[I] = '"' then
        Result := Result + StringOfChar('\', Slashes * 2 + 1)
      else
        Result := Result + StringOfChar('\', Slashes);
      Result := Result + S[I];
      Slashes := 0;
    end;
  end;
  Result := Result + StringOfChar('\', Slashes * 2) + '"';
end;

// Whether the command line holds Name as a word of its own (a switch with no value), in any case.
function CmdLineHas(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then Result := True;
end;

// -1, 0 or 1 as A is lower than, equal to or greater than B (both MAJOR.MINOR.BUILD).
function CompareVersions(const A, B: String): Integer;
var
  PA, PB: Int64;
begin
  if not StrToVersion(A, PA) then PA := 0;
  if not StrToVersion(B, PB) then PB := 0;
  Result := ComparePackedVersion(PA, PB);
  if Result < 0 then Result := -1 else if Result > 0 then Result := 1;
end;

// The build number of an install version: what follows its last dot.
function BuildOf(const V: String): String;
var
  I: Integer;
begin
  Result := V;
  for I := Length(V) downto 1 do
    if V[I] = '.' then
    begin
      Result := Copy(V, I + 1, Length(V));
      Exit;
    end;
end;

function InstalledWords(): String;
begin
  Result := 'AGMessage ' + InstalledSemVer + ' (build ' + BuildOf(InstalledVersion) + ')';
end;

// Words, then a further sentence.
function ThenSay(const Words, More: String): String;
begin
  if (Words <> '') and (Copy(Words, Length(Words), 1) = '.') then
    Result := Words + ' ' + More
  else
    Result := Words + '. ' + More;
end;

function Refuse(const Words: String): Boolean;
begin
  Log('refused: ' + Words);
  SuppressibleMsgBox(Words, mbCriticalError, MB_OK, IDOK);
  Result := False;
end;

// The folder an install may go into: Program Files\AGMessage.
function InstallFolder(): String;
begin
  Result := ExpandConstant('{autopf}\AGMessage');
end;

// Smart App Control's state (0 off, 1 on, 2 evaluating).
function SacState(): Integer;
var
  Value: Cardinal;
begin
  if RegQueryDWordValue(HKLM, 'SYSTEM\CurrentControlSet\Control\CI\Policy', 'VerifiedAndReputablePolicyState', Value) then
    Result := Value
  else
    Result := 0;
end;

// Whether the rules cover Public networks too: /PUBLICFIREWALL=1 or =0 when given, else what the record keeps, else not.
function PublicChosen(): Boolean;
var
  P: String;
begin
  P := ExpandConstant('{param:PUBLICFIREWALL|}');
  if P = '1' then Result := True
  else if P = '0' then Result := False
  else Result := PublicRecorded;
end;

// Runs this build's machine.js (its temporary copy, on its node.exe) with Verb and Params, hidden and waited for, its record
// read from --out: the exit code (-1 when it could not run), Json its record and Words its words. Params never carry a
// secret: the first admin account's password reaches machine.js in a file of machine\work\, never on a command line.
function Machine(const Verb, Params: String; var Json, Words: String): Integer;
var
  OutFile: String;
  Code: Integer;
begin
  OutFile := ExpandConstant('{tmp}') + '\machine-' + Verb + '.json';
  DeleteFile(OutFile);
  Json := '';
  Words := '';
  if not Exec(NodeExe, Arg(MachineJs) + ' ' + Verb + ' ' + Params + ' --out ' + Arg(OutFile), ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Words := 'machine.js ' + Verb + ' could not run (' + SysErrorMessage(Code) + ').';
    Result := -1;
  end
  else
  begin
    Result := Code;
    Json := Utf8File(OutFile);
    Words := JsonText(Json, 'words');
    if Words = '' then Words := 'machine.js ' + Verb + ' ended with ' + IntToStr(Code) + ' and wrote no words.';
  end;
  Log('machine.js ' + Verb + ' answered ' + IntToStr(Result) + ': ' + Words);
end;

function MachineArgs(): String;
begin
  Result := '--machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --port ' + IntToStr(Port);
end;

// preinstall-check's arguments: the port, and {app}, where no console may stay open; the reason typed, when there is one;
// and, for the way back (which stops nothing), that nothing may answer on the port.
function CheckArgs(const Reason: String): String;
begin
  Result := MachineArgs() + ' --app ' + Arg(InstallFolder());
  if Reason <> '' then Result := Result + ' --force ' + Arg(Reason);
  if Rollback then Result := Result + ' --rollback';
end;

// Words, then a further sentence, and how to go on anyway where a typed reason lifts the refusal (machine.js says so by
// `forceable`): the wizard has a field for the busy page's reason only.
function RefusalWords(const Json, Words, More: String): String;
begin
  Result := ThenSay(Words, More);
  if JsonTrue(Json, 'forceable') then
    Result := Result + ' To go on anyway, run this installer again from a command prompt with /FORCE="<why>".';
end;

// The install version of the files in Program Files\AGMessage (their app\build.json), or '' when it cannot be read.
function LaidVersion(): String;
begin
  Result := JsonText(Utf8File(InstallFolder() + '\app\build.json'), 'installVersion');
end;

// The plan's two readings of whose AGMessage it is, once the elevation is in: the account that started Setup writes its own
// whoami answer into the one-time setup folder (ExecAsOriginalUser returns only an exit code), and machine.js whose reads it,
// reads the owner of explorer.exe in this session and resolves /ADMIN. False when it cannot tell, with the words said.
function ReadWhose(): Boolean;
var
  Json, Words, Started, Asked, Params: String;
  Code: Integer;
begin
  Started := OneTimeDir + '\started.csv';
  if not ExecAsOriginalUser(ExpandConstant('{cmd}'), '/c ""' + ExpandConstant('{sys}\whoami.exe') + '" /user /fo csv /nh > "' + Started + '""', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Log('the account that started Setup could not be asked (' + SysErrorMessage(Code) + ')');
  Params := '--machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --started ' + Arg(Started);
  Asked := Trim(ExpandConstant('{param:ADMIN|}'));
  if Asked <> '' then Params := Params + ' --admin ' + Arg(Asked);
  Code := Machine('whose', Params, Json, Words);
  Result := Code = 0;
  if not Result then
  begin
    Refuse(ThenSay(Words, 'Nothing was installed.'));
    Exit;
  end;
  WhoseWords := Words;
  StartedSid := JsonText(Json, 'startedSid');
  AdminAgreed := JsonTrue(Json, 'agree');
  AdminSid := JsonText(Json, 'admin');
  AdminName := JsonText(Json, 'adminName');
  ChoiceCount := JsonInt(Json, 'choiceCount');
  Choice1Sid := JsonText(Json, 'choice1Sid');
  Choice1Name := JsonText(Json, 'choice1Name');
  Choice2Sid := JsonText(Json, 'choice2Sid');
  Choice2Name := JsonText(Json, 'choice2Name');
  if not AdminAgreed and (ChoiceCount < 1) then Result := Refuse(QuietAdminWords + ' Nothing was installed.');
end;

function InitializeSetup(): Boolean;
var
  Json, Words: String;
  Code: Integer;
  Value: Cardinal;
begin
  Result := False;
  Rollback := CmdLineHas('/ROLLBACK');
  Force := Trim(ExpandConstant('{param:FORCE|}'));
  MachineDir := ExpandConstant('{commonappdata}\AGMessage');
  // The one install record, machine.js install's: the version an upgrade compares, the one it replaced, the port and the
  // Public tick it keeps.
  Installed := RegQueryStringValue(HKLM64, RecordKey, 'Version', InstalledVersion) and (InstalledVersion <> '');
  if not RegQueryStringValue(HKLM64, RecordKey, 'SemVer', InstalledSemVer) then InstalledSemVer := '?';
  if not RegQueryStringValue(HKLM64, RecordKey, 'Previous', PreviousVersion) then PreviousVersion := '';
  if RegQueryDWordValue(HKLM64, RecordKey, 'Port', Value) and (Value > 0) and (Value < 65536) then Port := Value else Port := DefaultPort;
  PublicRecorded := RegQueryDWordValue(HKLM64, RecordKey, 'PublicFirewall', Value) and (Value = 1);

  // Program Files\AGMessage only, refused before anything is made (PrepareToInstall holds it again for {app}).
  if Trim(ExpandConstant('{param:DIR|}')) <> '' then
  begin
    Refuse('AGMessage installs only in ' + InstallFolder() + ', which only administrators may change, since its tasks run node.exe from there; /DIR= names another folder. Nothing was changed.');
    Exit;
  end;
  // The order is the install version's, MAJOR.MINOR.BUILD: only a newer build installs. /ROLLBACK lays back the build the
  // record names as Previous, or the build it still names when the files laid in Program Files\AGMessage are another
  // build's (a newer one that never recorded itself), and nothing else; preinstall-check --rollback then refuses while
  // anything answers on the port, since the way back stops nothing.
  if Installed then
  begin
    if Rollback then
    begin
      if not ((CompareVersions(PreviousVersion, '{#InstallVersion}') = 0) or ((CompareVersions(InstalledVersion, '{#InstallVersion}') = 0) and (LaidVersion() <> '') and (CompareVersions(LaidVersion(), '{#InstallVersion}') <> 0))) then
      begin
        Refuse('/ROLLBACK goes back only to the build this PC had before the one installed (' + InstalledWords() + '), and that is not this installer''s {#SemVer} (build {#Build}). Nothing was changed.');
        Exit;
      end;
    end
    else if CompareVersions(InstalledVersion, '{#InstallVersion}') > 0 then
    begin
      Refuse(InstalledWords() + ' is newer than this installer''s {#SemVer} (build {#Build}): uninstall it first to go back. Nothing was changed.');
      Exit;
    end
    else if CompareVersions(InstalledVersion, '{#InstallVersion}') = 0 then
    begin
      Refuse(InstalledWords() + ' is installed already: an installer upgrades only an older build. Nothing was changed.');
      Exit;
    end;
  end
  else if Rollback then
  begin
    Refuse('/ROLLBACK goes back to an earlier build of an installed AGMessage, and none is installed on this PC. Nothing was changed.');
    Exit;
  end;
  // A quiet first install shows no page to choose on: it names whose AGMessage it is.
  if WizardSilent and not Installed and (Trim(ExpandConstant('{param:ADMIN|}')) = '') then
  begin
    Refuse(QuietAdminWords + ' Nothing was changed.');
    Exit;
  end;

  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('machine.js');
  NodeExe := ExpandConstant('{tmp}\node.exe');
  MachineJs := ExpandConstant('{tmp}\machine.js');

  // The port and {app} looked at first, so a portable copy, another program or an open console is said before anything is
  // made. A busy AGMessage is the busy page's to ask about.
  Code := Machine('preinstall-check', CheckArgs(Force), Json, Words);
  if (Code <> 0) and not ((Code = 3) and JsonTrue(Json, 'busy')) then
  begin
    Refuse(ThenSay(Words, 'Nothing was changed.'));
    Exit;
  end;
  // The machine folder, race-free, before anything else of the install.
  Code := Machine('prepare', '--machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')), Json, Words);
  if Code <> 0 then
  begin
    Refuse(Words);
    Exit;
  end;
  OneTimeDir := JsonText(Json, 'setup');
  if Installed then
  begin
    if Trim(ExpandConstant('{param:ADMIN|}')) <> '' then Log('/ADMIN is not read on an upgrade: the record''s admin stays (a handover changes it)');
  end
  else if not ReadWhose() then
    Exit;
  if SacState() = SacEvaluating then Log('warning: ' + SacWords);
  Result := True;
end;

procedure InitializeWizard();
var
  AfterID: Integer;
begin
  AfterID := wpWelcome;
  if SacState() = SacEvaluating then
  begin
    SacPage := CreateOutputMsgPage(AfterID, 'Smart App Control', 'This installer is unsigned.', SacWords);
    AfterID := SacPage.ID;
  end;
  if not Installed then
  begin
    if AdminAgreed then
    begin
      AdminPage := CreateOutputMsgPage(AfterID, 'AGMessage''s admin on this PC', 'The Windows account AGMessage belongs to on this PC', WhoseWords + #13#10#13#10 + AdminRole);
      AfterID := AdminPage.ID;
    end
    else
    begin
      AdminChoicePage := CreateInputOptionPage(AfterID, 'AGMessage''s admin on this PC', 'Choose the Windows account AGMessage belongs to on this PC', WhoseWords + #13#10#13#10 + AdminRole, True, False);
      AdminChoicePage.Add(Choice1Name);
      if ChoiceCount > 1 then AdminChoicePage.Add(Choice2Name);
      AfterID := AdminChoicePage.ID;
    end;
  end;
  PublicPage := CreateInputOptionPage(AfterID, 'Networks', 'Who may reach AGMessage on this PC', PublicWords, False, False);
  PublicPage.Add('Also on Public networks (hotels, airports, fresh venue Wi-Fi)');
  PublicPage.Values[0] := PublicChosen();
  BusyPage := CreateInputQueryPage(PublicPage.ID, 'AGMessage is busy', 'It is in use now.', '');
  BusyPage.Add('Why stop it now (kept in AGMessage''s audit log):', False);
  BusyPage.Values[0] := Force;
  // The portable import, on a first install alone and before the first start: a choice, then the folder.
  AfterID := wpInfoAfter;
  if not Installed then
  begin
    ImportChoicePage := CreateInputOptionPage(wpInfoAfter, 'A portable AGMessage', 'Bring a portable AGMessage''s events here, before AGMessage first starts', ImportWords, True, False);
    ImportChoicePage.Add('Start with no halls');
    ImportChoicePage.Add('Import a portable AGMessage folder');
    ImportChoicePage.SelectedValueIndex := 0;
    ImportDirPage := CreateInputDirPage(ImportChoicePage.ID, 'Import a portable AGMessage', 'Choose its folder, then Next imports it', ImportHow, False, '');
    ImportDirPage.Add('The portable AGMessage folder (it holds start-agmessage.bat):');
    AfterID := ImportDirPage.ID;
  end;
  AccountPage := CreateInputQueryPage(AfterID, 'The first admin account', 'Make AGMessage''s first admin account', AccountWords);
  AccountPage.Add('User name:', False);
  AccountPage.Add('Your name:', False);
  AccountPage.Add('Password:', True);
  AccountPage.Add('Password again:', True);
end;

// Whether AGMessage is busy now, asked as the busy page is reached: its counts in the page's words.
function BusyNow(): Boolean;
var
  Json, Words: String;
  Code: Integer;
begin
  Code := Machine('preinstall-check', CheckArgs(''), Json, Words);
  Result := (Code = 3) and JsonTrue(Json, 'busy');
  if Result then
    BusyPage.SubCaptionLabel.Caption := Words + #13#10#13#10 + 'Type why it is stopped now: the reason is kept in AGMessage''s audit log, and the install goes on. Or cancel, and install once it is quiet.';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  // A quiet install asks nothing: its reason is /FORCE's, and its first admin account is made at Admin login.
  if WizardSilent and (((BusyPage <> nil) and (PageID = BusyPage.ID)) or ((AccountPage <> nil) and (PageID = AccountPage.ID))) then
    Result := True
  else if (BusyPage <> nil) and (PageID = BusyPage.ID) then
    Result := not BusyNow()
  else if (ImportChoicePage <> nil) and (PageID = ImportChoicePage.ID) then
    Result := not StartDeferred and not ImportFinished
  else if (ImportDirPage <> nil) and (PageID = ImportDirPage.ID) then
    Result := not (StartDeferred or ImportFinished) or (ImportChoicePage.SelectedValueIndex <> 1)
  else if (AccountPage <> nil) and (PageID = AccountPage.ID) then
    Result := not NeedsAccount;
end;

// Whether the portable import is offered: a first install shown to a person, set up, before its first start, for the
// account that started Setup, since its export runs as that account (whose profile holds the folder's keys) into that
// account's own inbox, which AGMessage's admin alone has on a first install.
function ImportOffered(): Boolean;
begin
  Result := not Installed and not Rollback and not WizardSilent and (StartedSid <> '') and (CompareText(StartedSid, AdminSid) = 0);
  if not Installed and not Rollback and not WizardSilent and not Result then
    Log('the portable import is not offered: AGMessage''s admin here is not the account that started Setup, as whom it runs');
end;

// The start and its verify, put off on a first install until the import page has been passed: the first admin account's
// page follows when the proven server says it has none.
function StartNow(): Boolean;
var
  Json, Words: String;
  Code: Integer;
begin
  Result := True;
  if not StartDeferred then Exit;
  StartDeferred := False;
  Code := Machine('start', MachineArgs() + ' --build ' + Arg('{#Full}'), Json, Words);
  if Code = 0 then
    NeedsAccount := JsonTrue(Json, 'needsAccount')
  else
  begin
    SetupFailed := True;
    SuppressibleMsgBox('AGMessage is installed and its server task registered, but it did not answer: ' + Words + #13#10#13#10 + 'Its server task starts it again with Windows: once the cause is cleared, restart this PC. Or uninstall AGMessage (its data is kept unless you choose otherwise) and install it again.', mbError, MB_OK, IDOK);
  end;
end;

// The import's words on its page, its last words there, and said in a box as well.
procedure ImportSays(const Words: String; Bad: Boolean);
begin
  ImportDirPage.SubCaptionLabel.Caption := Words;
  if Bad then SuppressibleMsgBox(Words, mbError, MB_OK, IDOK) else SuppressibleMsgBox(Words, mbInformation, MB_OK, IDOK);
end;

// What an import left before its end cleared (machine.js import --step clear): its bundle holds the portable folder's keys,
// so none of it stays in the account's inbox once the import has not gone on. What could not be removed is said.
procedure ImportClear();
var
  Json, Words: String;
begin
  if not ImportOpen then Exit;
  ImportOpen := False;
  if Machine('import', '--step clear --for ' + Arg(AdminSid) + ' --machine ' + Arg(MachineDir), Json, Words) <> 0 then
  begin
    Log('the import''s folder was not cleared: ' + Words);
    SuppressibleMsgBox(Words, mbError, MB_OK, IDOK);
  end;
end;

// The portable import, before the first start (U14): the import folder made ready for the account that started Setup
// (machine.js import --step stage), its export of the folder run as that account (launch.js export, by ExecAsOriginalUser:
// its keys are in its profile), the bundle taken and verified elevated (--step take), the old copies of the keys removed
// as that account once verified (launch.js forget-keys), and the end recorded (--step finish), whose words stay on the
// page. An import that does not go on is cleared (--step clear), as is one Setup leaves before its end. True when it is
// imported, every old copy went and the folder is marked; ImportFinished once it is imported at all.
function RunImport(const Folder: String): Boolean;
var
  Json, Words, Said, Id, Launch: String;
  Code: Integer;
begin
  Result := False;
  ImportDirPage.SubCaptionLabel.Caption := 'Importing: a large folder takes a moment...';
  Launch := Arg(ExpandConstant('{app}\app\launch.js'));
  Code := Machine('import', '--step stage --for ' + Arg(AdminSid) + ' --machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')), Json, Words);
  if Code <> 0 then
  begin
    ImportSays(Words, True);
    Exit;
  end;
  ImportOpen := True;
  if not ExecAsOriginalUser(ExpandConstant('{app}\node\node.exe'), Launch + ' export --source ' + Arg(Folder) + ' --machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --port ' + IntToStr(Port), ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    ImportClear();
    ImportSays('The portable folder could not be read as the account that started this installer (' + SysErrorMessage(Code) + '): nothing was imported.', True);
    Exit;
  end;
  Said := Utf8File(MachineDir + '\machine\inbox\' + AdminSid + '\import\export.json');
  Id := JsonText(Said, 'id');
  Words := JsonText(Said, 'words');
  Log('launch.js export answered ' + IntToStr(Code) + ': ' + Words);
  if (Code <> 0) or (Id = '') then
  begin
    ImportClear();
    if Words = '' then Words := 'The export gave no answer (it ended with ' + IntToStr(Code) + '): nothing was imported.';
    ImportSays(Words, True);
    Exit;
  end;
  Code := Machine('import', '--step take --for ' + Arg(AdminSid) + ' --machine ' + Arg(MachineDir) + ' --app ' + Arg(ExpandConstant('{app}')) + ' --source ' + Arg(Folder) + ' --sys ' + Arg(ExpandConstant('{sys}')), Json, Words);
  if Code <> 0 then
  begin
    ImportClear();
    ImportSays(Words, True);
    Exit;
  end;
  if not ExecAsOriginalUser(ExpandConstant('{app}\node\node.exe'), Launch + ' forget-keys --source ' + Arg(Folder) + ' --machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --id ' + Arg(Id), ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, Code) then
    Log('launch.js forget-keys could not be run as the account that started Setup (' + SysErrorMessage(Code) + ')');
  Code := Machine('import', '--step finish --for ' + Arg(AdminSid) + ' --machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --id ' + Arg(Id), Json, Words);
  ImportFinished := JsonTrue(Json, 'imported');
  // finish clears the import's folder itself; one it could not finish is cleared here.
  if ImportFinished then ImportOpen := False else ImportClear();
  if ImportFinished then
  begin
    ImportDirPage.Edits[0].Enabled := False;
    ImportDirPage.Buttons[0].Enabled := False;
  end;
  Result := Code = 0;
  ImportSays(Words, not Result);
end;

// The first admin account, through machine.js first-account and the server's /api/setup: the user name, the name and the
// password go in a file of machine\work\ (SYSTEM and Administrators only), which machine.js removes before it asks, and
// never in a command line or the log; machine.js sends them, with the token, only to this build's server once it has
// proved it holds the token. Empty fields leave it for Admin login.
function MakeAccount(): Boolean;
var
  Lines: TArrayOfString;
  FileName, Json, Words: String;
  Code: Integer;
begin
  Result := True;
  if (Trim(AccountPage.Values[0]) = '') and (Trim(AccountPage.Values[1]) = '') and (AccountPage.Values[2] = '') and (AccountPage.Values[3] = '') then
  begin
    Log('the first admin account is left for Admin login');
    Exit;
  end;
  if AccountPage.Values[2] <> AccountPage.Values[3] then
  begin
    MsgBox('The two passwords are not the same: type it again in both.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  FileName := MachineDir + '\machine\work\account.txt';
  SetArrayLength(Lines, 3);
  Lines[0] := Trim(AccountPage.Values[0]);
  Lines[1] := Trim(AccountPage.Values[1]);
  Lines[2] := AccountPage.Values[2];
  if not SaveStringsToUTF8File(FileName, Lines, False) then
  begin
    MsgBox('The account could not be handed to AGMessage: make it at Admin login with the token.', mbError, MB_OK);
    Exit;
  end;
  Code := Machine('first-account', '--machine ' + Arg(MachineDir) + ' --port ' + IntToStr(Port) + ' --build ' + Arg('{#Full}') + ' --account ' + Arg(FileName), Json, Words);
  DeleteFile(FileName);
  if Code = 0 then
    MsgBox(Words, mbInformation, MB_OK)
  else
  begin
    MsgBox(Words, mbError, MB_OK);
    Result := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if WizardSilent then Exit;
  if (AdminChoicePage <> nil) and (CurPageID = AdminChoicePage.ID) then
  begin
    if AdminChoicePage.SelectedValueIndex = 0 then
    begin
      AdminSid := Choice1Sid;
      AdminName := Choice1Name;
    end
    else if AdminChoicePage.SelectedValueIndex = 1 then
    begin
      AdminSid := Choice2Sid;
      AdminName := Choice2Name;
    end
    else
    begin
      MsgBox('Choose the account AGMessage belongs to on this PC.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if (BusyPage <> nil) and (CurPageID = BusyPage.ID) then
  begin
    if Trim(BusyPage.Values[0]) = '' then
    begin
      MsgBox('AGMessage is busy: type why it is stopped now, or cancel and install once it is quiet.', mbError, MB_OK);
      Result := False;
    end
    else
      Force := Trim(BusyPage.Values[0]);
  end
  else if (ImportChoicePage <> nil) and (CurPageID = ImportChoicePage.ID) then
  begin
    if ImportChoicePage.SelectedValueIndex = 0 then
    begin
      ImportClear();
      Result := StartNow();
    end;
  end
  else if (ImportDirPage <> nil) and (CurPageID = ImportDirPage.ID) then
  begin
    // Imported, its last words read: Next starts AGMessage. A refusal, or a verify that did not pass, keeps the page, the
    // folder there to change or Back to start with no halls; an import whose old copies did not all go keeps it once.
    if ImportFinished then
      Result := StartNow()
    else if RunImport(Trim(ImportDirPage.Values[0])) then
      Result := StartNow()
    else
      Result := False;
  end
  else if (AccountPage <> nil) and (CurPageID = AccountPage.ID) then
    Result := MakeAccount();
end;

// Just before anything is changed (Inno shows these words as the Preparing page's refusal): the folder must be Program
// Files\AGMessage; the check runs again, since the wizard may have waited on its pages; and an earlier install's server is
// stopped by this build's machine.js at loopback, where it saves and backs its data up (upgrade-stop), and nothing may still
// run from {app}. If the install does not reach its end, DeinitializeSetup starts the earlier server again. A rollback
// stops nothing: the newer build that went back had stopped already, and its backup was laid back.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir, Json, Words, Params: String;
  Code: Integer;
begin
  Result := '';
  if CompareText(RemoveBackslash(ExpandConstant('{app}')), InstallFolder()) <> 0 then
  begin
    Result := 'AGMessage installs only in ' + InstallFolder() + ', which only administrators may change, since its tasks run node.exe from there; ' + ExpandConstant('{app}') + ' was asked. Nothing was installed.';
    Log('refused: ' + Result);
    Exit;
  end;
  if Installed and RegQueryStringValue(HKLM64, RecordKey, 'InstallDir', Dir) and (Dir <> '') and (CompareText(RemoveBackslash(Dir), InstallFolder()) <> 0) then
  begin
    Result := 'The earlier install is in ' + Dir + ', not ' + InstallFolder() + ': uninstall it first, then install again. Nothing was installed.';
    Log('refused: ' + Result);
    Exit;
  end;
  Code := Machine('preinstall-check', CheckArgs(Force), Json, Words);
  if Code <> 0 then
  begin
    Result := RefusalWords(Json, Words, 'Nothing was installed.');
    Exit;
  end;
  if Installed and not Rollback then
  begin
    Params := MachineArgs() + ' --by ' + Arg('the installer, run by ' + ExpandConstant('{username}')) + ' --app ' + Arg(InstallFolder());
    if Force <> '' then Params := Params + ' --force ' + Arg(Force);
    // A refusal may come after the stop (a program still running from the folder): the earlier server is started again.
    EarlierStopped := True;
    Code := Machine('upgrade-stop', Params, Json, Words);
    if Code <> 0 then
    begin
      Result := RefusalWords(Json, Words, 'Nothing was replaced: the earlier AGMessage serves on, started again if it was stopped.');
      Exit;
    end;
    Backup := JsonText(Json, 'backup');
    // A reason given lifts the busy refusal and, with it, a missing save or backup: what that meant is said, not only logged.
    if JsonTrue(Json, 'forced') then SuppressibleMsgBox(Words, mbInformation, MB_OK, IDOK);
  end;
end;

// Two installers kept in {app}\installers: this one and the earlier build's, the way back's.
procedure KeepTwoInstallers();
var
  Rec: TFindRec;
  Dir, Mine, Earlier: String;
begin
  Dir := ExpandConstant('{app}\installers\');
  Mine := 'AGMessage-Setup-{#InstallVersion}-unsigned.exe';
  Earlier := 'AGMessage-Setup-' + InstalledVersion + '-unsigned.exe';
  if FindFirst(Dir + 'AGMessage-Setup-*-unsigned.exe', Rec) then
  begin
    try
      repeat
        if (CompareText(Rec.Name, Mine) <> 0) and not (Installed and (CompareText(Rec.Name, Earlier) = 0)) then
        begin
          if DeleteFile(Dir + Rec.Name) then Log('two installers are kept: removed ' + Rec.Name)
          else Log('two installers are kept, but ' + Rec.Name + ' could not be removed');
        end;
      until not FindNext(Rec);
    finally
      FindClose(Rec);
    end;
  end;
end;

// The kept installer is copied in only when this is not it: run from {app}\installers with /ROLLBACK, it is there already.
function KeepThisInstaller(): Boolean;
begin
  Result := CompareText(ExpandConstant('{srcexe}'), ExpandConstant('{app}\installers\AGMessage-Setup-{#InstallVersion}-unsigned.exe')) <> 0;
end;

// The way back, when the new build was not set up or did not answer: its server already ended (machine.js start ends one
// that does not answer), the backup its stop made laid back, then the kept installer of the earlier build run with
// /ROLLBACK, which lays the earlier files down, starts that build and verifies that it answers.
procedure GoBack(const Why: String);
var
  Json, Words, Kept: String;
  Code: Integer;
begin
  Kept := ExpandConstant('{app}\installers\AGMessage-Setup-') + InstalledVersion + '-unsigned.exe';
  Log('the way back: ' + Why);
  if Backup <> '' then
  begin
    WizardForm.StatusLabel.Caption := 'Laying back the data as it was before this upgrade...';
    Code := Machine('restore', '--machine ' + Arg(MachineDir) + ' --backup ' + Arg(Backup) + ' --port ' + IntToStr(Port), Json, Words);
    if Code <> 0 then
    begin
      SuppressibleMsgBox('AGMessage {#SemVer} (build {#Build}) did not start: ' + Why + #13#10#13#10 + 'Its data could not be laid back as it was before this upgrade: ' + Words + #13#10#13#10 + 'AGMessage is stopped. Lay the backup back (machine.js restore) before it starts again.', mbError, MB_OK, IDOK);
      Exit;
    end;
  end
  else
    Log('the way back has no backup to lay back: the upgrade went on without one, as asked');
  if not FileExists(Kept) then
  begin
    SuppressibleMsgBox('AGMessage {#SemVer} (build {#Build}) did not start: ' + Why + #13#10#13#10 + 'The earlier build''s installer is not kept in ' + Kept + ', so it could not be laid back. AGMessage is stopped: run that build''s installer yourself.', mbError, MB_OK, IDOK);
    Exit;
  end;
  WizardForm.StatusLabel.Caption := 'Going back to build ' + BuildOf(InstalledVersion) + '...';
  if not Exec(Kept, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ROLLBACK /LOG=' + Arg(ExpandConstant('{tmp}\rollback.log')), '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Log('the kept installer of build ' + BuildOf(InstalledVersion) + ' ended with ' + IntToStr(Code));
  if Code = 0 then
    SuppressibleMsgBox('AGMessage {#SemVer} (build {#Build}) did not start: ' + Why + #13#10#13#10 + 'So ' + InstalledWords() + ' was laid back, with its data as it was before this upgrade, and it answers.', mbError, MB_OK, IDOK)
  else
    SuppressibleMsgBox('AGMessage {#SemVer} (build {#Build}) did not start: ' + Why + #13#10#13#10 + 'Going back to ' + InstalledWords() + ' did not finish either (its installer ended with ' + IntToStr(Code) + '; its log is ' + ExpandConstant('{tmp}\rollback.log') + ', kept until this window closes). AGMessage is stopped.', mbError, MB_OK, IDOK);
end;

// After the files: the server task, the rules and the record (install), then the start and the verify (start: the server
// must prove it holds the machine folder's token, as this build); the first admin account's page follows when the proven
// server says it has none. A new build that is not set up or does not answer goes back.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Json, Words, Params: String;
  Code: Integer;
  PartsSet: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;
  ReachedPostInstall := True;
  KeepTwoInstallers();
  WizardForm.StatusLabel.Caption := 'Setting up AGMessage''s server task, its firewall rules and its record...';
  Params := '--machine ' + Arg(MachineDir) + ' --app ' + Arg(ExpandConstant('{app}')) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --build ' + Arg('{#Full}') + ' --port ' + IntToStr(Port);
  if not Installed then Params := Params + ' --admin ' + Arg(AdminSid) + ' --admin-name ' + Arg(AdminName);
  if PublicPage.Values[0] then Params := Params + ' --public';
  if Rollback then Params := Params + ' --rollback';
  Code := Machine('install', Params, Json, Words);
  PartsSet := Code = 0;
  // A first install shown to a person starts once its import page is passed: the import comes before the first start.
  if PartsSet and ImportOffered() then
  begin
    StartDeferred := True;
    Exit;
  end;
  if PartsSet then
  begin
    WizardForm.StatusLabel.Caption := 'Starting AGMessage and waiting for it to answer...';
    Code := Machine('start', MachineArgs() + ' --build ' + Arg('{#Full}'), Json, Words);
    if Code = 0 then
    begin
      NeedsAccount := JsonTrue(Json, 'needsAccount');
      Exit;
    end;
  end;
  SetupFailed := True;
  if Installed and not Rollback then
    GoBack(Words)
  else if Rollback then
    SuppressibleMsgBox('The earlier build of AGMessage was laid back, but it did not start either: ' + Words, mbError, MB_OK, IDOK)
  else if PartsSet then
    // The record names this build now, so this installer would refuse to run again: the task is what starts it.
    SuppressibleMsgBox('AGMessage is installed and its server task registered, but it did not answer: ' + Words + #13#10#13#10 + 'Its server task starts it again with Windows: once the cause is cleared, restart this PC. Or uninstall AGMessage (its data is kept unless you choose otherwise) and install it again.', mbError, MB_OK, IDOK)
  else
    SuppressibleMsgBox('AGMessage''s files are in place, but it is not set up: ' + Words + #13#10#13#10 + 'Uninstall AGMessage (its data is kept unless you choose otherwise), then install it again once the cause is cleared.', mbError, MB_OK, IDOK);
end;

function GetCustomSetupExitCode(): Integer;
begin
  if SetupFailed then Result := 3 else Result := 0;
end;

// An upgrade that stopped the earlier server and did not reach its end (refused, cancelled, a file it could not replace:
// Inno rolls its files back) starts the earlier server again; a first install that did not finish leaves no setup folder.
procedure DeinitializeSetup();
var
  Json, Words: String;
begin
  if EarlierStopped and not ReachedPostInstall then
  begin
    Machine('start', MachineArgs(), Json, Words);
    Log('the install did not finish: the earlier build was started again');
  end;
  // An import Setup left before its end leaves no bundle (it holds the portable folder's keys) in the account's inbox.
  ImportClear();
  // A first install whose import page was never passed starts AGMessage now, as its server task would at the next boot.
  if StartDeferred then
  begin
    StartDeferred := False;
    Machine('start', MachineArgs() + ' --build ' + Arg('{#Full}'), Json, Words);
    Log('the import page was not passed: AGMessage was started with what its folders hold');
  end;
  if (not ReachedPostInstall) and (OneTimeDir <> '') and DirExists(OneTimeDir) then
    DelTree(OneTimeDir, True, True, True);
end;

// The uninstall's one question, its answer No unless the person chooses Yes (the box "Remove all AGMessage data from this PC",
// unticked: the uninstaller has no pages).
function RemoveDataQuestion(const Dir: String): String;
begin
  Result := 'Remove all AGMessage data from this PC?' + #13#10#13#10 + 'No keeps every hall, account, file and key in ' + Dir + ', so AGMessage installed again finds them. Yes removes them, the keys last; it cannot be undone.';
end;

// After the person's confirmation and before any file is removed: whether the data goes too (unticked: kept), then
// machine.js uninstall, which refuses while a console of the Start menu is open, stops the server at loopback (it saves),
// removes every task of \AGMessage\ and waits for every program of {app} to end, removes the rules and the record, and the
// data when asked, the keys last; data kept has every account's rights on it taken back and is marked for AGMessage
// installed again. Anything it could not take back stops the uninstall with every file still in place, so nothing of the
// machine points at files that are gone.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Said, Params, Json, Words, Reason: String;
  RemoveData: Boolean;
begin
  if CurUninstallStep <> usUninstall then Exit;
  MachineDir := ExpandConstant('{commonappdata}\AGMessage');
  RemoveData := CmdLineHas('/REMOVEDATA') or (ExpandConstant('{param:REMOVEDATA|}') = '1');
  if not RemoveData and not UninstallSilent then
    RemoveData := MsgBox(RemoveDataQuestion(MachineDir), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Said := ExpandConstant('{tmp}\uninstall.json');
  Params := Arg(ExpandConstant('{app}\app\machine.js')) + ' uninstall --machine ' + Arg(MachineDir) + ' --sys ' + Arg(ExpandConstant('{sys}')) + ' --app ' + Arg(ExpandConstant('{app}')) + ' --out ' + Arg(Said);
  if RemoveData then Params := Params + ' --remove-data';
  Reason := Trim(ExpandConstant('{param:FORCE|}'));
  if Reason <> '' then Params := Params + ' --force ' + Arg(Reason);
  if not Exec(ExpandConstant('{app}\node\node.exe'), Params, ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Refuse('The machine-level uninstall could not run (' + SysErrorMessage(Code) + '): nothing was removed.');
    Abort;
  end;
  Json := Utf8File(Said);
  Words := JsonText(Json, 'words');
  Log('machine.js uninstall answered ' + IntToStr(Code) + ': ' + Words);
  if Code <> 0 then
  begin
    if Words = '' then Words := 'machine.js uninstall ended with ' + IntToStr(Code) + ' and said nothing.';
    // The uninstaller has no page to type a reason on: the one way to stop a busy AGMessage anyway is said whole.
    if JsonTrue(Json, 'forceable') then Words := ThenSay(Words, 'To uninstall a busy AGMessage anyway, run "' + ExpandConstant('{uninstallexe}') + '" /FORCE="<why>" from a command prompt (the reason is kept in AGMessage''s audit log), or uninstall it once it is quiet.');
    Refuse('The uninstall stopped before any file was removed: ' + Words);
    Abort;
  end;
end;
