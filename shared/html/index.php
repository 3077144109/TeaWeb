<?php
	$testXF = false;
	$localhost = false;
	$_INCLIDE_ONLY = true;

	if (file_exists('auth.php'))
		include_once('auth.php');
	else if (file_exists('auth/auth.php'))
		include_once('auth/auth.php');
	else {
		function authPath() {
			return "";
		}

		function redirectOnInvalidSession()
		{
		}

		function logged_in() {
		    return false;
        }
	}
	$localhost |= gethostname() == "WolverinDEV";
	if(!$localhost || $testXF) {
		//redirectOnInvalidSession();
	}

	$WEB_CLIENT = http_response_code() !== false;
?>

<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
        <meta name="description" content="TeaSpeak Web Client, connect to any TeaSpeak server without installing anything." />

        <?php
            if(!$WEB_CLIENT) {
                echo "<title>TeaClient</title>";
            } else {
				echo "<title>TeaSpeak-Web</title>";
            }
        ?>

        <!-- PHP generated properties -->
        <x-properties id="properties">
			<?php
				function spawn_property($name, $value)
				{
				    if(isset($value))
					    echo "\t\t\t<x-property key=\"" . $name . "\" value=\"" . urlencode($value) . "\"></x-property>\r\n";
				}

				spawn_property('connect_default_host', $localhost ? "localhost" : "ts.TeaSpeak.de");
				spawn_property('localhost_debug', $localhost ? "true" : "false");
				spawn_property('forum_user_data', isset($GLOBALS["COOKIE_NAME_USER_DATA"]) ? $_COOKIE[$GLOBALS["COOKIE_NAME_USER_DATA"]] : null);
				spawn_property('forum_user_sign', isset($GLOBALS["COOKIE_NAME_USER_SIGN"]) ? $_COOKIE[$GLOBALS["COOKIE_NAME_USER_SIGN"]] : null);
				spawn_property('forum_path', authPath());

				$version = file_get_contents("./version");
				if ($version === false)
				    $version = "unknown";
				spawn_property("version", $version);
			?>
        </x-properties>

        <!-- Global site tag (gtag.js) - Google Analytics -->
        <script async src="https://www.googletagmanager.com/gtag/js?id=UA-113151733-4"></script>
        <script>
            window.dataLayer = window.dataLayer || [];

            function gtag() {
                dataLayer.push(arguments);
            }

            gtag('js', new Date());
            gtag('config', 'UA-113151733-4');
        </script>

        <!-- required static style for the critical page and the enable javascript page -->
        <style>
            .fulloverlay {
                z-index: 10000;
                display: none;
                position: fixed;

                top: 0;
                bottom: 0;
                left: 0;
                right: 0;

                background-color: gray;
                text-align: center;
            }

            .fulloverlay .container {
                position: relative;
                display: inline-block;
                top: 30%
            }

            .no-js {
                display: block;
            }
        </style>

        <div id="style">
            <link rel="stylesheet" href="css/loader/loader.css">
        </div>
        <div id="scripts">
            <script type="application/javascript" src="js/load.js" defer></script>
        </div>
    </head>
    <body>
        <!-- No javascript error -->
        <div class="fulloverlay no-js">
            <div class="container">
                <img src="img/script.svg" height="128px">
                <h1>Please enable JavaScript</h1>
                <h3>TeaSpeak web could not run without it!</h3>
                <h3>Its like you, without coffee</h3>
            </div>
        </div>
        <script type="text/javascript" class="no-js">
            let elements = document.getElementsByClassName("no-js");
            while (elements.length > 0) //Removing these elements (even self)
                elements.item(0).remove();
        </script>

        <!-- Loading screen -->
        <div class="loader">
            <div class="half right"></div>
            <div class="half left"></div>
            <div class="bookshelf_wrapper">
                <ul class="books_list">
                    <li class="book_item first"></li>
                    <li class="book_item second"></li>
                    <li class="book_item third"></li>
                    <li class="book_item fourth"></li>
                    <li class="book_item fifth"></li>
                    <li class="book_item sixth"></li>
                </ul>
                <div class="shelf"></div>
            </div>
        </div>

        <!-- Critical load error -->
        <div class="fulloverlay" id="critical-load">
            <div class="container">
                <img src="img/script.svg" height="128px">
                <h1 style="color: red">Got some trouble while loading important files!</h1>
                <h3 class="detail"></h3>
            </div>
        </div>

        <div id="music-test"></div>
        <div id="templates"></div>
        <div id="sounds"></div>
        <div id="mouse-move">
            <div class="container">
            </div>
        </div>
    </body>

    <?php
        $footer_style = "display: none;";
        $footer_forum = '';

		if($WEB_CLIENT) {
			$footer_style = "display: block;";

			if (logged_in()) {
				$footer_forum = "<a href=\"" . authPath() . "auth.php?type=logout\">logout</a>";
			} else {
				$footer_forum = "<a href=\"" . authPath() . "login.php\">Login</a> via the TeaSpeak forum.";
			}
		}
    ?>

    <footer style="<?php echo $footer_style; ?>">
        <div class="container" style="display: flex; flex-direction: row; align-content: space-between;">
            <div style="align-self: center; position: fixed; left: 5px;">Open source on <a href="https://github.com/TeaSpeak/TeaSpeak-Web" style="display: inline-block; position: relative">github.com</a></div>
            <div style="align-self: center;">TeaSpeak Web client (<?php echo $version; ?>) by WolverinDEV</div>
            <div style="align-self: center; position: fixed; right: 5px;"><?php echo $footer_forum; ?></div>
        </div>
    </footer>
</html>