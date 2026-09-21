Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 800,600
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font 'Arial',28
$content = "Омлет с помидором`n`n2 яйца, 1 помидор, соль.`n`n1. Взбейте яйца с солью.`n2. Нарежьте помидор.`n3. Жарьте всё 5 минут.`n`n1 порция."
$graphics.DrawString($content,$font,[System.Drawing.Brushes]::Black,30,30)
$bitmap.Save((Join-Path (Get-Location) 'data/test-recipe.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$font.Dispose()
$bitmap.Dispose()
Write-Output 'TEST_IMAGE_CREATED'
