import javax.inject.Inject

plugins {
    id("com.android.application")
}

// The app shows the web app's own pages, and takes its version number from it, so the two stay the same.
val web: File = rootDir.parentFile
val webVersion = Regex("VERSION = '(\\d+)\\.(\\d+)'").find(File(web, "sw.js").readText())
    ?: error("No VERSION in sw.js")
val (major, minor) = webVersion.destructured

android {
    namespace = "com.neckfors.bookshelf"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.neckfors.bookshelf"
        minSdk = 26
        targetSdk = 37
        versionCode = major.toInt() * 100 + minor.toInt()
        versionName = "$major.$minor"
    }

    buildTypes {
        release {
            // Installed from GitHub, not a store: the PC's debug key, like the other apps. Every release
            // must be signed with the same key, or it cannot be installed over the previous one.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

abstract class WebAssets @Inject constructor(private val files: FileSystemOperations) : DefaultTask() {
    @get:InputFiles
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val root: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun copy() {
        files.sync {
            from(root) { include("index.html", "style.css", "manifest.webmanifest", "js/**", "icons/**") }
            into(output.dir("web"))
        }
    }
}

val webAssets = tasks.register<WebAssets>("webAssets") {
    root.set(web)
    sources.from(listOf("index.html", "style.css", "manifest.webmanifest").map { File(web, it) })
    sources.from(fileTree(File(web, "js")), fileTree(File(web, "icons")))
}

androidComponents {
    onVariants { it.sources.assets?.addGeneratedSourceDirectory(webAssets, WebAssets::output) }
}
