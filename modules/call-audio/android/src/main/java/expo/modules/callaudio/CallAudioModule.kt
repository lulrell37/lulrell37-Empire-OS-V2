// A.R.A. LIVE plays her voice through Android's call audio path (owner, 2026-11-27:
// "how do apps get it to be perfect and not hear itself?"). The mic already records
// with the VOICE_COMMUNICATION source; playing her clips as USAGE_VOICE_COMMUNICATION
// while the audio mode is IN_COMMUNICATION puts them in the same call session, so the
// phone's own echo canceller has them as its reference and removes them from the mic.
// Clips are prepared ahead and started on cue, so sentences run together without gaps.
package expo.modules.callaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CallAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val audio: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val players = mutableMapOf<Int, MediaPlayer>()
  private var nextId = 1
  private var savedMode = AudioManager.MODE_NORMAL

  private fun release(id: Int) {
    players.remove(id)?.let { mp ->
      try { mp.stop() } catch (_: Throwable) {}
      try { mp.release() } catch (_: Throwable) {}
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CallAudio")

    // On: call mode, out of the loudspeaker. Off: back to how it was.
    AsyncFunction("setCallMode") { on: Boolean ->
      val am = audio
      if (on) {
        savedMode = am.mode
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
          am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
        } else {
          @Suppress("DEPRECATION")
          am.isSpeakerphoneOn = true
        }
      } else {
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
        else {
          @Suppress("DEPRECATION")
          am.isSpeakerphoneOn = false
        }
        am.mode = savedMode
      }
      true
    }.runOnQueue(Queues.MAIN)

    // A clip (file:// uri) loaded on the call path, not playing yet -> its id.
    AsyncFunction("prepare") { uri: String, promise: Promise ->
      val id = nextId++
      val mp = MediaPlayer()
      try {
        mp.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        mp.setDataSource(context, Uri.parse(uri))
        players[id] = mp
        mp.setOnPreparedListener { promise.resolve(id) }
        mp.setOnErrorListener { _, what, extra ->
          release(id)
          promise.reject("E_CALL_AUDIO", "couldn't load the clip ($what/$extra)", null)
          true
        }
        mp.prepareAsync()
      } catch (e: Throwable) {
        release(id)
        promise.reject("E_CALL_AUDIO", e.message ?: "couldn't load the clip", e)
      }
    }.runOnQueue(Queues.MAIN)

    // Plays a prepared clip; resolves when it ends (true) or is stopped (false).
    AsyncFunction("play") { id: Int, promise: Promise ->
      val mp = players[id]
      if (mp == null) { promise.resolve(false); return@AsyncFunction }
      var settled = false
      mp.setOnCompletionListener {
        if (!settled) { settled = true; release(id); promise.resolve(true) }
      }
      mp.setOnErrorListener { _, _, _ ->
        if (!settled) { settled = true; release(id); promise.resolve(false) }
        true
      }
      try { mp.start() } catch (e: Throwable) { settled = true; release(id); promise.resolve(false) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("release") { id: Int -> release(id); true }.runOnQueue(Queues.MAIN)

    // Barge-in / hang-up: every clip stops at once.
    AsyncFunction("stopAll") {
      for (id in players.keys.toList()) release(id)
      true
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      for (id in players.keys.toList()) release(id)
    }
  }
}
