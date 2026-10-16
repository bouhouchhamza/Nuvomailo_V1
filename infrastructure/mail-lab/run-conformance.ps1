param([switch]$ColdRestore)
$ErrorActionPreference = 'Stop'
$labRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $labRoot
$labCompose = @('compose', '-f', 'infrastructure/mail-lab/compose.yaml')
$labResults = [System.Collections.Generic.List[object]]::new()
function Invoke-LabDocker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Lab Docker operation failed (exit $LASTEXITCODE)" }
}
function Read-LabResult {
    param([string[]]$Arguments)
    $output = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Lab test failed (exit $LASTEXITCODE)" }
    $json = @($output | Where-Object { $_ -match '^\{' }) | Select-Object -Last 1
    if (!$json) { throw 'Lab did not return structured evidence' }
    $result = $json | ConvertFrom-Json
    if ($result.error) { throw "Lab reported $($result.error)" }
    $labResults.Add($result)
    Write-Host $json
    return $result
}
function Invoke-Phase { param([string]$Phase)
    return Read-LabResult ($labCompose + @('run','--rm','worker','node','dist/mail-lab/conformance.js',$Phase))
}
function Invoke-Probe { param([string]$Probe)
    return Read-LabResult ($labCompose + @('exec','-T','mail','python3','/opt/nuvomailo-lab/probe.py',$Probe))
}
function Wait-LabMail { param([string[]]$ComposeArguments)
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        $output = & docker @ComposeArguments exec -T mail python3 /opt/nuvomailo-lab/probe.py ready
        if ($LASTEXITCODE -eq 0 -and $output -match '"ready": true') { return }
        Start-Sleep -Seconds 2
    }
    throw 'Lab mail readiness timeout'
}
$restoreCompose = $null
try {
    & npm --prefix backend run build
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
    Invoke-LabDocker ($labCompose + @('build','worker'))
    Invoke-LabDocker ($labCompose + @('up','-d','mail','db'))
    Invoke-LabDocker ($labCompose + @('restart','mail'))
    Wait-LabMail $labCompose
    $null=Read-LabResult ($labCompose + @('run','--rm','worker','node','dist/mail-lab/client.js','seed'))
    $null=Read-LabResult ($labCompose + @('exec','-T','mail','python3','/opt/nuvomailo-lab/security_tests.py','prepare'))
    Invoke-LabDocker ($labCompose + @('restart','mail'))
    Wait-LabMail $labCompose
    $null=Read-LabResult ($labCompose + @('exec','-T','mail','python3','/opt/nuvomailo-lab/security_tests.py','restart'))
    $null=Invoke-Phase baseline
    $null=Invoke-Probe partial-fault
    $null=Invoke-Phase partial
    $null=Invoke-Probe alias
    $null=Invoke-Phase collision
    $before=Invoke-Probe append
    $null=Invoke-Phase suspend
    $suspended=Invoke-Probe auth
    if ($suspended.imap -or $suspended.smtp) { throw 'Suspended authentication was accepted' }
    $inbound=Invoke-Probe inbound
    if (!$inbound.smtpAccepted -or !$inbound.deliveredWhileAuthSuspended) { throw 'Suspension receiving semantics changed; review provider policy' }
    $null=Invoke-Phase resume
    $active=Invoke-Probe auth
    if (!$active.imap -or !$active.smtp) { throw 'Resumed authentication failed' }
    $after=Invoke-Probe messages
    if ($after.messages -lt $before.messages) { throw 'Mail was lost across suspension' }
    $null=Invoke-Phase quota100
    $quota=Invoke-Probe quota
    if (!$quota.overQuotaRejected) { throw 'Actual storage quota was not enforced' }
    $null=Invoke-Phase quota200
    $null=Invoke-Probe drift
    $null=Invoke-Phase drift
    $null=Invoke-Probe acceptance-fault
    $null=Invoke-Phase acceptance
    $crashOutput=& docker @labCompose run --rm worker node dist/mail-lab/conformance.js crash-effect
    if ($LASTEXITCODE -ne 77 -or $crashOutput -notmatch '"workerEffectAppliedBeforeExit":true') { throw 'Expected post-effect worker crash was not observed' }
    $labResults.Add(@{workerProcessExitedBeforeAck=$true;expectedExitCode=77})
    $null=Invoke-Phase recover-crash
    $null=Invoke-Phase quota200
    Invoke-LabDocker ($labCompose + @('restart','mail'))
    Wait-LabMail $labCompose
    $null=Invoke-Phase restart
    $scheme=Invoke-Probe scheme
    $nodeArgon=& node infrastructure/mail-lab/argon-compatibility.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node Argon2 compatibility failed' }
    $labResults.Add(($nodeArgon | ConvertFrom-Json))
    Write-Host $nodeArgon
    $argv=Invoke-Probe argv
    if ($argv.passwordInArgv) { throw 'Synthetic password exposed in argv' }
    $messages=Invoke-Probe messages
    $labIds=@(& docker @labCompose ps -q mail db)
    $stats=& docker stats --no-stream --format '{{json .}}' @labIds
    if ($LASTEXITCODE -ne 0) { throw 'Resource observation failed' }
    $labResults.Add(@{resourceObservation=@($stats | ForEach-Object { $_ | ConvertFrom-Json });representativeLoad=$false})
    Invoke-LabDocker ($labCompose + @('exec','-T','mail','supervisorctl','stop','postfix','dovecot','changedetector'))
    $backup=Invoke-Probe backup
    if (!$backup.metadataRestored -or !$backup.mailFilesRestored) { throw 'Snapshot comparison failed' }
    if ($ColdRestore) {
        $restoreProject='nuvomailo-dms-lab-restore-'+(Get-Date -Format 'yyyyMMddHHmmss')
        $restoreCompose=@('compose','-p',$restoreProject,'-f','infrastructure/mail-lab/restore.compose.yaml')
        Invoke-LabDocker ($restoreCompose + @('up','-d'))
        Wait-LabMail $restoreCompose
        $restoredAuth=Read-LabResult ($restoreCompose + @('exec','-T','mail','python3','/opt/nuvomailo-lab/probe.py','auth'))
        $restoredMessages=Read-LabResult ($restoreCompose + @('exec','-T','mail','python3','/opt/nuvomailo-lab/probe.py','messages'))
        if (!$restoredAuth.imap -or !$restoredAuth.smtp -or $restoredMessages.messages -ne $messages.messages) { throw 'Cold-restore authentication/mail comparison failed' }
        $labResults.Add(@{coldRestorePassed=$true;messages=$restoredMessages.messages;project=$restoreProject})
    }
    $directory=Join-Path $PSScriptRoot 'results'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $report=Join-Path $directory ((Get-Date -Format 'yyyyMMddHHmmss')+'.json')
    $labResults | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding utf8
    Write-Host "Conformance evidence: $report"
} finally {
    # Stop only this lab's services. Never remove containers/volumes or reset data here.
    & docker @labCompose stop mail db
    if ($restoreCompose) { & docker @restoreCompose stop mail }
    Pop-Location
}
