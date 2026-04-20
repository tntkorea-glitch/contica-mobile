package expo.modules.contactsbatch

import android.content.ContentProviderOperation
import android.content.ContentValues
import android.provider.ContactsContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ContactsBatchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ContactsBatch")

    AsyncFunction("getPhoneGroups") {
      val resolver = appContext.reactContext?.contentResolver
        ?: throw Exception("contentResolver unavailable")
      val results = mutableListOf<Map<String, Any?>>()
      val cursor = resolver.query(
        ContactsContract.Groups.CONTENT_URI,
        arrayOf(ContactsContract.Groups._ID, ContactsContract.Groups.TITLE, ContactsContract.Groups.DELETED),
        "${ContactsContract.Groups.DELETED} = 0",
        null,
        null
      )
      cursor?.use {
        while (it.moveToNext()) {
          results.add(mapOf(
            "id" to it.getLong(0).toString(),
            "title" to (it.getString(1) ?: "")
          ))
        }
      }
      return@AsyncFunction results
    }

    AsyncFunction("createPhoneGroup") { title: String ->
      val resolver = appContext.reactContext?.contentResolver
        ?: throw Exception("contentResolver unavailable")
      val values = ContentValues().apply {
        put(ContactsContract.Groups.TITLE, title)
        put(ContactsContract.Groups.GROUP_VISIBLE, 1)
      }
      val uri = resolver.insert(ContactsContract.Groups.CONTENT_URI, values)
      val id = uri?.lastPathSegment?.toLongOrNull()
      return@AsyncFunction (id ?: -1L).toString()
    }

    AsyncFunction("addContactsBatch") { contacts: List<Map<String, Any?>> ->
      val resolver = appContext.reactContext?.contentResolver
        ?: throw Exception("contentResolver unavailable")

      val BATCH_LIMIT = 500
      val allContactIds = mutableListOf<String>()

      var start = 0
      while (start < contacts.size) {
        val end = (start + BATCH_LIMIT).coerceAtMost(contacts.size)
        val slice = contacts.subList(start, end)
        val ops = ArrayList<ContentProviderOperation>()
        val rawIndexes = mutableListOf<Int>()

        for (c in slice) {
          val rawIdx = ops.size
          rawIndexes.add(rawIdx)
          ops.add(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
              .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
              .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
              .build()
          )

          val firstName = (c["firstName"] as? String) ?: ""
          val lastName = (c["lastName"] as? String) ?: ""
          if (firstName.isNotEmpty() || lastName.isNotEmpty()) {
            ops.add(
              ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
                .withValue(
                  ContactsContract.Data.MIMETYPE,
                  ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE
                )
                .withValue(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME, firstName)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME, lastName)
                .build()
            )
          }

          @Suppress("UNCHECKED_CAST")
          val phones = (c["phoneNumbers"] as? List<Map<String, Any?>>) ?: emptyList()
          for (p in phones) {
            val number = (p["number"] as? String) ?: continue
            if (number.isEmpty()) continue
            val label = (p["label"] as? String) ?: "mobile"
            val type = when (label.lowercase()) {
              "home" -> ContactsContract.CommonDataKinds.Phone.TYPE_HOME
              "work" -> ContactsContract.CommonDataKinds.Phone.TYPE_WORK
              "mobile" -> ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE
              else -> ContactsContract.CommonDataKinds.Phone.TYPE_OTHER
            }
            ops.add(
              ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
                .withValue(
                  ContactsContract.Data.MIMETYPE,
                  ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE
                )
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, type)
                .build()
            )
          }

          @Suppress("UNCHECKED_CAST")
          val emails = (c["emails"] as? List<Map<String, Any?>>) ?: emptyList()
          for (e in emails) {
            val email = (e["email"] as? String) ?: continue
            if (email.isEmpty()) continue
            val label = (e["label"] as? String) ?: "home"
            val type = when (label.lowercase()) {
              "home" -> ContactsContract.CommonDataKinds.Email.TYPE_HOME
              "work" -> ContactsContract.CommonDataKinds.Email.TYPE_WORK
              else -> ContactsContract.CommonDataKinds.Email.TYPE_OTHER
            }
            ops.add(
              ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
                .withValue(
                  ContactsContract.Data.MIMETYPE,
                  ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE
                )
                .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
                .withValue(ContactsContract.CommonDataKinds.Email.TYPE, type)
                .build()
            )
          }

          val company = (c["company"] as? String) ?: ""
          val jobTitle = (c["jobTitle"] as? String) ?: ""
          if (company.isNotEmpty() || jobTitle.isNotEmpty()) {
            ops.add(
              ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
                .withValue(
                  ContactsContract.Data.MIMETYPE,
                  ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE
                )
                .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, company)
                .withValue(ContactsContract.CommonDataKinds.Organization.TITLE, jobTitle)
                .build()
            )
          }

          @Suppress("UNCHECKED_CAST")
          val groupIds = (c["groupIds"] as? List<String>) ?: emptyList()
          for (gid in groupIds) {
            val gidLong = gid.toLongOrNull() ?: continue
            if (gidLong <= 0) continue
            ops.add(
              ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
                .withValue(
                  ContactsContract.Data.MIMETYPE,
                  ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE
                )
                .withValue(
                  ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID,
                  gidLong
                )
                .build()
            )
          }
        }

        val results = resolver.applyBatch(ContactsContract.AUTHORITY, ops)
        val rawIds = mutableListOf<Long>()
        for (idx in rawIndexes) {
          val uri = results.getOrNull(idx)?.uri
          val id = uri?.lastPathSegment?.toLongOrNull() ?: -1L
          rawIds.add(id)
        }

        val validIds = rawIds.filter { it > 0 }
        val contactIdMap = mutableMapOf<Long, Long>()
        if (validIds.isNotEmpty()) {
          val cursor = resolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID, ContactsContract.RawContacts.CONTACT_ID),
            "${ContactsContract.RawContacts._ID} IN (${validIds.joinToString(",")})",
            null,
            null
          )
          cursor?.use {
            while (it.moveToNext()) {
              contactIdMap[it.getLong(0)] = it.getLong(1)
            }
          }
        }

        for (rid in rawIds) {
          allContactIds.add(if (rid > 0) (contactIdMap[rid] ?: rid).toString() else "")
        }

        start = end
      }

      return@AsyncFunction allContactIds
    }
  }
}
