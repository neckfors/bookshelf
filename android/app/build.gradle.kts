plugins {
    id("com.android.application")
}

android {
    namespace = "com.neckfors.bookshelf.speedtest"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.neckfors.bookshelf.speedtest"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            // A throwaway test app, installed by hand: the PC's debug key is enough.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
