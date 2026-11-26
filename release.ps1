# Publishes the Android app: builds it, makes a GitHub release with the APK, then updates version.json,
# which is how installed apps find out. The version comes from sw.js. Commit and push your changes first.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Checked([string]$what, [scriptblock]$run) {
    & $run
    if ($LASTEXITCODE -ne 0) { throw "$what failed" }
}

if (git status --porcelain) { throw 'There are uncommitted changes.' }
Invoke-Checked 'git fetch' { git fetch -q }
if ((git rev-parse HEAD) -ne (git rev-parse '@{u}')) { throw 'This copy and GitHub differ. Push or pull first.' }

if ((Get-Content sw.js -Raw) -notmatch "VERSION = '(\d+)\.(\d+)'") { throw 'No VERSION in sw.js' }
$name = "$($Matches[1]).$($Matches[2])"
$code = [int]$Matches[1] * 100 + [int]$Matches[2]

$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
Invoke-Checked 'The build' { android\gradlew.bat -p android assembleRelease -q --console=plain }

$named = Join-Path $env:TEMP "bookshelf-$name.apk"
Copy-Item android\app\build\outputs\apk\release\app-release.apk $named -Force
Invoke-Checked 'The release' {
    gh release create "v$name" $named -R neckfors/bookshelf --title "v$name" --notes "Download the APK below and open it on your tablet or phone."
}

Set-Content version.json "{`"versionCode`": $code, `"versionName`": `"$name`"}" -Encoding ascii
Invoke-Checked 'git add' { git add version.json }
Invoke-Checked 'git commit' { git commit -q -m "Release $name" }
Invoke-Checked 'git pull' { git pull -q --rebase }
Invoke-Checked 'git push' { git push -q }
Write-Host "Released $name"
