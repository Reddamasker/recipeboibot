$ErrorActionPreference = 'Stop'
$assetDirectory = $PSScriptRoot
function ImageData([string]$name) { 'data:image/jpeg;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $assetDirectory $name))) }
$listImage = ImageData 'telegram-ios-chat-list-official.jpg'
$voiceImage = ImageData 'telegram-ios-voice-official.jpg'
$chatImage = ImageData 'telegram-ios-chat-official.jpg'
$svg = @"
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="560" height="3540" viewBox="0 0 560 3540">
<rect width="560" height="3540" fill="#F3F0F7"/>
<g font-family="Inter,Arial,sans-serif" fill="#302537">
<text x="34" y="43" font-size="13" fill="#A4415C" font-weight="700">КЛИЕНТСКИЙ ПУТЬ · TELEGRAM НА IPHONE</text>
<text x="34" y="82" font-size="28" font-weight="700">Из чатов — к рецепту</text>
<text x="34" y="112" font-size="16">Читайте сверху вниз. Отмечено, куда нажимать.</text>
<text x="34" y="137" font-size="13" fill="#756B7D">Официальные демо-скриншоты, не ваши личные чаты.</text>

<rect x="24" y="164" width="512" height="1132" rx="20" fill="white"/>
<text x="45" y="201" font-size="22" font-weight="700">1. Откройте чат бота</text>
<text x="45" y="229" font-size="15">Старт — список чатов Telegram, не Mini App.</text>
<image x="73" y="254" width="414" height="896.31" xlink:href="$listImage"/>
<!-- Editable scenario overlay: only the bot row is a mock; the UI is the official screenshot. -->
<g id="Строка бота — макет поверх скриншота">
<rect x="74" y="496" width="412" height="83" fill="white"/>
<circle cx="118" cy="538" r="32" fill="#209FE2"/>
<rect x="103" y="527" width="30" height="24" rx="6" fill="none" stroke="white" stroke-width="2"/>
<circle cx="112" cy="536" r="2" fill="white"/><circle cx="124" cy="536" r="2" fill="white"/>
<path d="M118 520v7 M109 545h18" stroke="white" stroke-width="2"/>
<text x="163" y="525" font-size="19" font-weight="700">Бот рецептов</text>
<text x="163" y="550" font-size="16" fill="#8E8E93">Спросите, что приготовить</text>
<rect x="78" y="499" width="404" height="77" rx="10" fill="none" stroke="#B02A60" stroke-width="3"/>
<circle cx="468" cy="500" r="17" fill="#B02A60"/><text x="462" y="506" font-size="17" fill="white" font-weight="700">1</text>
</g>
<text x="45" y="1183" font-size="16" font-weight="700">Если чат не виден — найдите бота через Search.</text>
<text x="45" y="1210" font-size="14" fill="#756B7D">Закрепление чата не требуется.</text>
<text x="45" y="1240" font-size="12" fill="#756B7D">Скриншот Telegram iOS. Только строка бота добавлена</text>
<text x="45" y="1260" font-size="12" fill="#756B7D">для сценария. Остальные чаты — официальный демо-контент.</text>
<path d="M280 1313v30m-8-8 8 8 8-8" fill="none" stroke="#A4415C" stroke-width="3"/>

<rect x="24" y="1364" width="512" height="822" rx="20" fill="white"/>
<text x="45" y="1402" font-size="22" font-weight="700">2. Надиктуйте в чат</text>
<text x="45" y="1433" font-size="15">Зажмите микрофон, скажите запрос и отправьте.</text>
<text x="45" y="1460" font-size="16" font-weight="700">«Есть курица. Что приготовить на ужин?»</text>
<image x="45" y="1490" width="470" height="470" xlink:href="$voiceImage"/>
<circle cx="409" cy="1943" r="21" fill="none" stroke="#B02A60" stroke-width="3"/>
<path d="M356 1993h35l14-27" stroke="#B02A60" stroke-width="3" fill="none"/>
<text x="45" y="1997" font-size="16" font-weight="700" fill="#B02A60">Микрофон справа от поля ввода</text>
<text x="45" y="2040" font-size="15">Это настоящее расположение контрола Telegram.</text>
<text x="45" y="2066" font-size="14" fill="#756B7D">На кадре — официальный демо-чат, не наш бот.</text>
<text x="45" y="2092" font-size="14" fill="#756B7D">Ни меню приложения, ни форма поиска не нужны.</text>
<text x="45" y="2131" font-size="12" fill="#756B7D">Кадр официальной демонстрации Telegram от 03.06.2025.</text>
<text x="45" y="2152" font-size="12" fill="#756B7D">Внешний вид может отличаться в вашей версии iOS.</text>
<path d="M280 2200v30m-8-8 8 8 8-8" fill="none" stroke="#A4415C" stroke-width="3"/>

<rect x="24" y="2250" width="512" height="1094" rx="20" fill="white"/>
<text x="45" y="2288" font-size="22" font-weight="700">3. Откройте рецепт из ответа</text>
<text x="45" y="2317" font-size="15">Бот отвечает здесь же, в Telegram.</text>
<rect x="45" y="2338" width="470" height="35" rx="9" fill="#F7E3E8"/>
<text x="59" y="2361" font-size="13" fill="#9E3158" font-weight="700">МАКЕТ БУДУЩЕГО ОТВЕТА, НЕ РАБОТАЮЩАЯ ФУНКЦИЯ</text>
<!-- Real Telegram chrome retained; proposed bot content is editable vector artwork. -->
<image x="73" y="2390" width="414" height="896.31" xlink:href="$chatImage"/>
<rect x="168" y="2442" width="312" height="40" fill="#F9F9FB"/>
<text x="223" y="2459" font-size="18" font-weight="700">Бот рецептов</text>
<text x="266" y="2476" font-size="12" fill="#8E8E93">бот</text>
<rect x="73" y="2488" width="414" height="706" fill="#DBE8DD"/>
<rect x="166" y="2511" width="305" height="78" rx="18" fill="#DDFBC7"/>
<text x="184" y="2540" font-size="15" font-weight="700">Ваше голосовое</text>
<path d="M185 2563h8m5-8v16m7-21v26m7-18v10m7-22v34m7-27v20m7-22v26m7-16v8m7-22v35m7-27v19m7-12v7m7-19v28m7-19v10m7-16v21m7-28v32m7-20v12" stroke="#48983A" stroke-width="3"/>
<text x="434" y="2570" font-size="12" fill="#579849">0:08</text>
<rect x="88" y="2610" width="365" height="301" rx="18" fill="white"/>
<text x="106" y="2643" font-size="18" font-weight="700">Ищу курицу на ужин</text>
<text x="106" y="2674" font-size="15">Нашёл в ваших сохранённых рецептах:</text>
<text x="106" y="2717" font-size="20" font-weight="700">Крылышки с мёдом</text>
<text x="106" y="2744" font-size="20" font-weight="700">и маслом чили</text>
<text x="106" y="2777" font-size="14" fill="#8E8E93">YouTube · FutureCanoe</text>
<text x="106" y="2809" font-size="14">Время приготовления не указано.</text>
<rect x="101" y="2840" width="339" height="55" rx="10" fill="#D8EDD9"/>
<text x="187" y="2874" font-size="18" fill="#257D42" font-weight="700">Открыть рецепт</text>
<rect x="97" y="2836" width="347" height="63" rx="13" fill="none" stroke="#B02A60" stroke-width="3"/>
<circle cx="441" cy="2836" r="17" fill="#B02A60"/><text x="435" y="2842" font-size="17" fill="white" font-weight="700">3</text>
<rect x="88" y="2924" width="365" height="49" rx="10" fill="#D8EDD9"/>
<text x="182" y="2955" font-size="16" fill="#257D42">Все результаты</text>
<rect x="88" y="2987" width="365" height="49" rx="10" fill="#D8EDD9"/>
<text x="178" y="3018" font-size="16" fill="#257D42">Уточнить запрос</text>
<text x="97" y="3082" font-size="14" fill="#496650">Понятный запрос — сразу результат.</text>
<text x="97" y="3108" font-size="14" fill="#496650">Без обязательного подтверждения текста.</text>
<text x="45" y="3317" font-size="13" fill="#756B7D">Рамка Telegram — скриншот. Сообщения бота — макет.</text>

<rect x="24" y="3368" width="512" height="144" rx="20" fill="#302537"/>
<text x="45" y="3404" font-size="22" fill="white" font-weight="700">→ Сразу экран нужного рецепта</text>
<text x="45" y="3435" font-size="15" fill="#DDF18A">Без главной Mini App и повторного поиска.</text>
<text x="45" y="3466" font-size="13" fill="#E7DEF0">Существующий экран 04 остаётся без переработки.</text>
<text x="45" y="3489" font-size="12" fill="#E7DEF0">Источники: telegram.org/tour/screenshots и блог Telegram.</text>
</g></svg>
"@
$outputPath = Join-Path $assetDirectory 'telegram-real-screens-journey.svg'
[IO.File]::WriteAllText($outputPath, $svg, [Text.UTF8Encoding]::new($false))
Write-Output $outputPath
$stepSpecs = @(
  @{ Name='telegram-path-01-chats.svg'; Start='<text x="34" y="43"'; End='<path d="M280 1313'; Y=0; Height=1296 },
  @{ Name='telegram-path-02-voice.svg'; Start='<rect x="24" y="1364"'; End='<path d="M280 2200'; Y=1364; Height=822 },
  @{ Name='telegram-path-03-result.svg'; Start='<rect x="24" y="2250"'; End='</g></svg>'; Y=2250; Height=1290 }
)
foreach ($step in $stepSpecs) {
  $startIndex = $svg.IndexOf($step.Start)
  $endIndex = $svg.IndexOf($step.End, $startIndex)
  $stepBody = $svg.Substring($startIndex, $endIndex - $startIndex)
  $stepSvg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="560" height="' + $step.Height + '" viewBox="0 0 560 ' + $step.Height + '"><rect width="560" height="' + $step.Height + '" fill="#F3F0F7"/><g font-family="Inter,Arial,sans-serif" fill="#302537" transform="translate(0,-' + $step.Y + ')">' + $stepBody + '</g></svg>'
  $stepPath = Join-Path $assetDirectory $step.Name
  [IO.File]::WriteAllText($stepPath, $stepSvg, [Text.UTF8Encoding]::new($false))
  Write-Output $stepPath
}
