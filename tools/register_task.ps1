# Registers a Windows Scheduled Task that scrapes twice a day (07:00 and 18:00).
#
# Two runs a day is the design: cheap cars move within hours so one run misses
# things, and more than two adds account risk without finding much more.
#
#   powershell -ExecutionPolicy Bypass -File tools/register_task.ps1
#
# Check it:   schtasks /Query  /TN CarScraper
# Run now:    schtasks /Run    /TN CarScraper
# Remove it:  schtasks /Delete /TN CarScraper /F

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node 22+ first.' }

$runner = Join-Path $projectRoot 'tools\run_scheduled.cmd'
@"
@echo off
cd /d "$projectRoot"
set LOGFILE=data\logs\scrape-%DATE:/=-%.log
echo ==== %DATE% %TIME% ==== >> "%LOGFILE%"
"$node" --disable-warning=ExperimentalWarning tools\scrape.js >> "%LOGFILE%" 2>&1
"@ | Set-Content -Path $runner -Encoding ASCII

$action    = New-ScheduledTaskAction -Execute $runner
$morning   = New-ScheduledTaskTrigger -Daily -At 7:00am
$evening   = New-ScheduledTaskTrigger -Daily -At 6:00pm
# The machine has to be awake -- this is a desktop, not a server. Missed runs are
# not backfilled, which is fine: Marketplace listings live for days.
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
                                          -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName 'CarScraper' `
                       -Action $action `
                       -Trigger @($morning, $evening) `
                       -Settings $settings `
                       -Description 'Scrape Facebook Marketplace for flippable cars (DFW + Houston)' `
                       -Force | Out-Null

Write-Host 'Registered scheduled task "CarScraper" for 07:00 and 18:00 daily.'
Write-Host "Logs: $logDir"
Write-Host 'Remove with: schtasks /Delete /TN CarScraper /F'
