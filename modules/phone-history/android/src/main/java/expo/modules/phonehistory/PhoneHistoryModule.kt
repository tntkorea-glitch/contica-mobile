package expo.modules.phonehistory

import android.Manifest
import android.content.pm.PackageManager
import android.provider.CallLog
import android.provider.Telephony
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PhoneHistoryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PhoneHistory")

    AsyncFunction("getPermissions") {
      val ctx = appContext.reactContext ?: throw Exception("No context")
      return@AsyncFunction mapOf(
        "callLog" to (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG)
          == PackageManager.PERMISSION_GRANTED),
        "sms" to (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_SMS)
          == PackageManager.PERMISSION_GRANTED)
      )
    }

    AsyncFunction("requestPermissions") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("NO_ACTIVITY", "currentActivity가 없습니다", null)
        return@AsyncFunction
      }

      val perms = arrayOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_SMS)
      val missing = perms.filter {
        ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
      }

      if (missing.isEmpty()) {
        promise.resolve(mapOf("callLog" to true, "sms" to true))
        return@AsyncFunction
      }

      // Simple request — Expo permission listener 없이 직접 요청. 결과는 current state로 재조회.
      ActivityCompat.requestPermissions(activity, missing.toTypedArray(), REQUEST_CODE)

      // 결과를 비동기적으로 받지 않고, 잠시 후 현재 상태 조회해서 반환
      // (Expo의 공식 permission flow와 다르지만 간단함)
      Thread {
        Thread.sleep(300)
        val result = mapOf(
          "callLog" to (ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_CALL_LOG)
            == PackageManager.PERMISSION_GRANTED),
          "sms" to (ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_SMS)
            == PackageManager.PERMISSION_GRANTED)
        )
        promise.resolve(result)
      }.start()
    }

    AsyncFunction("getCallLog") { limit: Int? ->
      val ctx = appContext.reactContext ?: throw Exception("No context")
      if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG)
          != PackageManager.PERMISSION_GRANTED) {
        throw Exception("READ_CALL_LOG 권한이 없습니다")
      }

      val effectiveLimit = limit ?: 1000
      val results = mutableListOf<Map<String, Any?>>()

      val projection = arrayOf(
        CallLog.Calls.NUMBER,
        CallLog.Calls.CACHED_NAME,
        CallLog.Calls.DATE,
        CallLog.Calls.TYPE,
        CallLog.Calls.DURATION
      )

      val cursor = ctx.contentResolver.query(
        CallLog.Calls.CONTENT_URI,
        projection,
        null,
        null,
        "${CallLog.Calls.DATE} DESC"
      )

      cursor?.use {
        val numberIdx = it.getColumnIndex(CallLog.Calls.NUMBER)
        val nameIdx = it.getColumnIndex(CallLog.Calls.CACHED_NAME)
        val dateIdx = it.getColumnIndex(CallLog.Calls.DATE)
        val typeIdx = it.getColumnIndex(CallLog.Calls.TYPE)
        val durIdx = it.getColumnIndex(CallLog.Calls.DURATION)

        while (it.moveToNext()) {
          if (results.size >= effectiveLimit) break
          val number = if (numberIdx >= 0) it.getString(numberIdx) else null
          if (number.isNullOrBlank()) continue
          val type = if (typeIdx >= 0) it.getInt(typeIdx) else 0
          val typeStr = when (type) {
            CallLog.Calls.INCOMING_TYPE -> "incoming"
            CallLog.Calls.OUTGOING_TYPE -> "outgoing"
            CallLog.Calls.MISSED_TYPE -> "missed"
            CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
            CallLog.Calls.REJECTED_TYPE -> "rejected"
            CallLog.Calls.BLOCKED_TYPE -> "blocked"
            else -> "other"
          }
          results.add(
            mapOf(
              "number" to number,
              "name" to (if (nameIdx >= 0) it.getString(nameIdx) else null),
              "timestamp" to (if (dateIdx >= 0) it.getLong(dateIdx) else 0L),
              "type" to typeStr,
              "duration" to (if (durIdx >= 0) it.getLong(durIdx) else 0L)
            )
          )
        }
      }

      return@AsyncFunction results
    }

    AsyncFunction("getSmsLog") { limit: Int? ->
      val ctx = appContext.reactContext ?: throw Exception("No context")
      if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_SMS)
          != PackageManager.PERMISSION_GRANTED) {
        throw Exception("READ_SMS 권한이 없습니다")
      }

      val effectiveLimit = limit ?: 1000
      val results = mutableListOf<Map<String, Any?>>()

      val projection = arrayOf(
        Telephony.Sms.ADDRESS,
        Telephony.Sms.PERSON,
        Telephony.Sms.DATE,
        Telephony.Sms.BODY,
        Telephony.Sms.TYPE
      )

      val cursor = ctx.contentResolver.query(
        Telephony.Sms.CONTENT_URI,
        projection,
        null,
        null,
        "${Telephony.Sms.DATE} DESC"
      )

      cursor?.use {
        val addressIdx = it.getColumnIndex(Telephony.Sms.ADDRESS)
        val dateIdx = it.getColumnIndex(Telephony.Sms.DATE)
        val bodyIdx = it.getColumnIndex(Telephony.Sms.BODY)
        val typeIdx = it.getColumnIndex(Telephony.Sms.TYPE)

        while (it.moveToNext()) {
          if (results.size >= effectiveLimit) break
          val address = if (addressIdx >= 0) it.getString(addressIdx) else null
          if (address.isNullOrBlank()) continue
          val type = if (typeIdx >= 0) it.getInt(typeIdx) else 0
          val typeStr = when (type) {
            Telephony.Sms.MESSAGE_TYPE_INBOX -> "inbox"
            Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
            Telephony.Sms.MESSAGE_TYPE_DRAFT -> "draft"
            Telephony.Sms.MESSAGE_TYPE_OUTBOX -> "outbox"
            Telephony.Sms.MESSAGE_TYPE_FAILED -> "failed"
            Telephony.Sms.MESSAGE_TYPE_QUEUED -> "queued"
            else -> "other"
          }
          results.add(
            mapOf(
              "number" to address,
              "name" to null,
              "timestamp" to (if (dateIdx >= 0) it.getLong(dateIdx) else 0L),
              "body" to (if (bodyIdx >= 0) (it.getString(bodyIdx) ?: "") else ""),
              "type" to typeStr
            )
          )
        }
      }

      return@AsyncFunction results
    }
  }

  companion object {
    private const val REQUEST_CODE = 42013
  }
}
