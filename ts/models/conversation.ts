import Backbone from 'backbone';
import _ from 'lodash';
import { ConversationType } from '../receiver/common';
import { getMessageQueue } from '../session';
import { ConversationController } from '../session/conversations';
import {
  ChatMessage,
  ExpirationTimerUpdateMessage,
  GroupInvitationMessage,
  OpenGroupMessage,
  ReadReceiptMessage,
  TypingMessage,
} from '../session/messages/outgoing';
import { ClosedGroupChatMessage } from '../session/messages/outgoing/content/data/group';
import { OpenGroup, PubKey } from '../session/types';
import { ToastUtils, UserUtils } from '../session/utils';
import { BlockedNumberController } from '../util';
import { MessageController } from '../session/messages';
import { leaveClosedGroup } from '../session/group';
import { SignalService } from '../protobuf';
import { MessageCollection, MessageModel } from './message';
import * as Data from '../../js/modules/data';
import { IncomingMessageCreationAttributes, initIncomingMessage, initOutgoingMessage, MessageModelType, OutgoingMessageCreationAttributes } from './messageType';

export interface OurLokiProfile {
  displayName: string;
  avatarPointer: string;
  profileKey: Uint8Array | null;
}

export interface ConversationAttributes {
  profileName?: string;
  id: string;
  name?: string;
  members: Array<string>;
  left: boolean;
  expireTimer: number;
  profileSharing: boolean;
  mentionedUs: boolean;
  unreadCount: number;
  lastMessageStatus: string | null;
  active_at: number;
  lastJoinedTimestamp: number; // ClosedGroup: last time we were added to this group
  groupAdmins?: Array<string>;
  moderators?: Array<string>; // TODO to merge to groupAdmins with a migration on the db
  isKickedFromGroup?: boolean;
  avatarPath?: string;
  isMe?: boolean;
  subscriberCount?: number;
  sessionRestoreSeen?: boolean;
  is_medium_group?: boolean;
  type: string;
  lastMessage?: string | null;
  avatarPointer?: any;
  avatar?: any;
  server?: any;
  channelId?: any;
  nickname?: string;
  profile?: any;
  lastPublicMessage?: any;
  profileAvatar?: any;
  profileKey?: string;
  accessKey?: any;
}

export interface ConversationAttributesOptionals {
  profileName?: string;
  id: string;
  name?: string;
  members?: Array<string>;
  left?: boolean;
  expireTimer?: number;
  profileSharing?: boolean;
  mentionedUs?: boolean;
  unreadCount?: number;
  lastMessageStatus?: string | null;
  active_at?: number;
  timestamp?: number; // timestamp of what?
  lastJoinedTimestamp?: number;
  groupAdmins?: Array<string>;
  moderators?: Array<string>;
  isKickedFromGroup?: boolean;
  avatarPath?: string;
  isMe?: boolean;
  subscriberCount?: number;
  sessionRestoreSeen?: boolean;
  is_medium_group?: boolean;
  type: string;
  lastMessage?: string | null;
  avatarPointer?: any;
  avatar?: any;
  server?: any;
  channelId?: any;
  nickname?: string;
  profile?: any;
  lastPublicMessage?: any;
  profileAvatar?: any;
  profileKey?: string;
  accessKey?: any;
}

/**
 * This function mutates optAttributes
 * @param optAttributes the entry object attributes to set the defaults to.
 */
export const fillConvoAttributesWithDefaults = (
  optAttributes: ConversationAttributesOptionals
): ConversationAttributes => {
  return _.defaults(optAttributes, {
    members: [],
    left: false,
    profileSharing: false,
    unreadCount: 0,
    lastMessageStatus: null,
    lastJoinedTimestamp: new Date('1970-01-01Z00:00:00:000').getTime(),
    groupAdmins: [],
    moderators: [],
    isKickedFromGroup: false,
    isMe: false,
    subscriberCount: 0,
    sessionRestoreSeen: false,
    is_medium_group: false,
    lastMessage: null,
    expireTimer: 0,
    mentionedUs: false,
    active_at: 0,
  });
};

export class ConversationModel extends Backbone.Model<ConversationAttributes> {
  public updateLastMessage: () => any;
  public messageCollection: MessageCollection;
  public throttledBumpTyping: any;
  public initialPromise: any;

  private typingRefreshTimer?: NodeJS.Timeout | null;
  private typingPauseTimer?: NodeJS.Timeout | null;
  private typingTimer?: NodeJS.Timeout | null;

  private cachedProps: any;

  private pending: any;
  // storeName: 'conversations',

  constructor(attributes: ConversationAttributesOptionals) {
    super(fillConvoAttributesWithDefaults(attributes));

    // This may be overridden by ConversationController.getOrCreate, and signify
    //   our first save to the database. Or first fetch from the database.
    this.initialPromise = Promise.resolve();

    this.messageCollection = new MessageCollection([], {
      conversation: this,
    });
    this.updateExpirationTimer = this.updateExpirationTimer.bind(this);

    this.throttledBumpTyping = _.throttle(this.bumpTyping, 300);
    this.updateLastMessage = _.throttle(
      this.bouncyUpdateLastMessage.bind(this),
      1000
    );
    // this.listenTo(
    //   this.messageCollection,
    //   'add remove destroy',
    //   debouncedUpdateLastMessage
    // );
    // Listening for out-of-band data updates
    this.on('delivered', this.updateAndMerge);
    this.on('read', this.updateAndMerge);
    this.on('expiration-change', this.updateAndMerge);
    this.on('expired', this.onExpired);

    this.on('ourAvatarChanged', avatar =>
      this.updateAvatarOnPublicChat(avatar)
    );

    // Always share profile pics with public chats
    if (this.isPublic()) {
      this.set('profileSharing', true);
    }

    this.typingRefreshTimer = null;
    this.typingPauseTimer = null;

    // Keep props ready
    const generateProps = () => {
      this.cachedProps = this.getProps();
    };
    this.on('change', generateProps);
    generateProps();
  }

  public idForLogging() {
    if (this.isPrivate()) {
      return this.id;
    }

    return `group(${this.id})`;
  }

  public isMe() {
    return UserUtils.isUsFromCache(this.id);
  }
  public isPublic() {
    return !!(this.id && this.id.match(/^publicChat:/));
  }
  public isClosedGroup() {
    return this.get('type') === ConversationType.GROUP && !this.isPublic();
  }

  public isBlocked() {
    if (!this.id || this.isMe()) {
      return false;
    }

    if (this.isClosedGroup()) {
      return BlockedNumberController.isGroupBlocked(this.id);
    }

    if (this.isPrivate()) {
      return BlockedNumberController.isBlocked(this.id);
    }

    return false;
  }

  public isMediumGroup() {
    return this.get('is_medium_group');
  }
  public async block() {
    if (!this.id || this.isPublic()) {
      return;
    }

    const promise = this.isPrivate()
      ? BlockedNumberController.block(this.id)
      : BlockedNumberController.blockGroup(this.id);
    await promise;
    await this.commit();
  }

  public async unblock() {
    if (!this.id || this.isPublic()) {
      return;
    }
    const promise = this.isPrivate()
      ? BlockedNumberController.unblock(this.id)
      : BlockedNumberController.unblockGroup(this.id);
    await promise;
    await this.commit();
  }
  public async bumpTyping() {
    if (this.isPublic() || this.isMediumGroup()) {
      return;
    }
    // We don't send typing messages if the setting is disabled
    // or we blocked that user

    if (!window.storage.get('typing-indicators-setting') || this.isBlocked()) {
      return;
    }

    if (!this.typingRefreshTimer) {
      const isTyping = true;
      this.setTypingRefreshTimer();
      this.sendTypingMessage(isTyping);
    }

    this.setTypingPauseTimer();
  }

  public setTypingRefreshTimer() {
    if (this.typingRefreshTimer) {
      clearTimeout(this.typingRefreshTimer);
    }
    this.typingRefreshTimer = global.setTimeout(
      this.onTypingRefreshTimeout.bind(this),
      10 * 1000
    );
  }

  public onTypingRefreshTimeout() {
    const isTyping = true;
    this.sendTypingMessage(isTyping);

    // This timer will continue to reset itself until the pause timer stops it
    this.setTypingRefreshTimer();
  }

  public setTypingPauseTimer() {
    if (this.typingPauseTimer) {
      clearTimeout(this.typingPauseTimer);
    }
    this.typingPauseTimer = global.setTimeout(
      this.onTypingPauseTimeout.bind(this),
      10 * 1000
    );
  }

  public onTypingPauseTimeout() {
    const isTyping = false;
    this.sendTypingMessage(isTyping);

    this.clearTypingTimers();
  }

  public clearTypingTimers() {
    if (this.typingPauseTimer) {
      clearTimeout(this.typingPauseTimer);
      this.typingPauseTimer = null;
    }
    if (this.typingRefreshTimer) {
      clearTimeout(this.typingRefreshTimer);
      this.typingRefreshTimer = null;
    }
  }

  public sendTypingMessage(isTyping: boolean) {
    if (!this.isPrivate()) {
      return;
    }

    const recipientId = this.id;

    if (!recipientId) {
      throw new Error('Need to provide either recipientId');
    }

    const primaryDevicePubkey = window.storage.get('primaryDevicePubKey');
    if (recipientId && primaryDevicePubkey === recipientId) {
      // note to self
      return;
    }

    const typingParams = {
      timestamp: Date.now(),
      isTyping,
      typingTimestamp: Date.now(),
    };
    const typingMessage = new TypingMessage(typingParams);

    // send the message to a single recipient if this is a session chat
    const device = new PubKey(recipientId);
    getMessageQueue()
      .sendToPubKey(device, typingMessage)
      .catch(window.log.error);
  }

  public async cleanup() {
    const { deleteAttachmentData } = window.Signal.Migrations;
    await window.Signal.Types.Conversation.deleteExternalFiles(
      this.attributes,
      {
        deleteAttachmentData,
      }
    );
    window.profileImages.removeImage(this.id);
  }

  public async updateProfileAvatar() {
    if (this.isPublic()) {
      return;
    }

    // Remove old identicons
    if (window.profileImages.hasImage(this.id)) {
      window.profileImages.removeImage(this.id);
      await this.setProfileAvatar(null);
    }
  }

  public async updateAndMerge(message: any) {
    await this.updateLastMessage();

    const mergeMessage = () => {
      const existing = this.messageCollection.get(message.id);
      if (!existing) {
        return;
      }

      existing.merge(message.attributes);
    };

    mergeMessage();
  }

  public async onExpired(message: any) {
    await this.updateLastMessage();

    const removeMessage = () => {
      const { id } = message;
      const existing = this.messageCollection.get(id);
      if (!existing) {
        return;
      }

      window.log.info('Remove expired message from collection', {
        sentAt: existing.get('sent_at'),
      });

      this.messageCollection.remove(id);
      existing.trigger('expired');
    };

    removeMessage();
  }

  // Get messages with the given timestamp
  public getMessagesWithTimestamp(pubKey: string, timestamp: number) {
    if (this.id !== pubKey) {
      return [];
    }

    // Go through our messages and find the one that we need to update
    return this.messageCollection.models.filter(
      (m: any) => m.get('sent_at') === timestamp
    );
  }

  public async onCalculatingPoW(pubKey: string, timestamp: number) {
    const messages = this.getMessagesWithTimestamp(pubKey, timestamp);
    await Promise.all(messages.map((m: any) => m.setCalculatingPoW()));
  }

  public async onPublicMessageSent(
    identifier: any,
    serverId: any,
    serverTimestamp: any
  ) {
    const registeredMessage = window.getMessageController().get(identifier);

    if (!registeredMessage || !registeredMessage.message) {
      return null;
    }
    const model = registeredMessage.message;
    await model.setIsPublic(true);
    await model.setServerId(serverId);
    await model.setServerTimestamp(serverTimestamp);
    return undefined;
  }
  public addSingleMessage(
    message: IncomingMessageCreationAttributes | OutgoingMessageCreationAttributes,
    setToExpire = true
  ) {
    const model = this.messageCollection.add(message, { merge: true });
    if (setToExpire) {
      void model.setToExpire();
    }
    return model;
  }
  public format() {
    return this.cachedProps;
  }
  public getGroupAdmins() {
    return this.get('groupAdmins') || this.get('moderators');
  }
  public getProps() {
    const groupAdmins = this.getGroupAdmins();

    const members =
      this.isGroup() && !this.isPublic() ? this.get('members') : undefined;

    const result = {
      id: this.id as string,
      activeAt: this.get('active_at'),
      avatarPath: this.getAvatarPath(),
      type: this.isPrivate() ? 'private' : 'group',
      isMe: this.isMe(),
      isPublic: this.isPublic(),
      isTyping: !!this.typingTimer,
      name: this.getName(),
      profileName: this.getProfileName(),
      title: this.getTitle(),
      unreadCount: this.get('unreadCount') || 0,
      mentionedUs: this.get('mentionedUs') || false,
      isBlocked: this.isBlocked(),
      phoneNumber: this.id,
      lastMessage: {
        status: this.get('lastMessageStatus'),
        text: this.get('lastMessage'),
      },
      hasNickname: !!this.getNickname(),
      isKickedFromGroup: !!this.get('isKickedFromGroup'),
      left: !!this.get('left'),
      groupAdmins,
      members,
      onClick: () => this.trigger('select', this),
      onBlockContact: () => this.block(),
      onUnblockContact: () => this.unblock(),
      onCopyPublicKey: this.copyPublicKey,
      onDeleteContact: this.deleteContact,
      onLeaveGroup: () => {
        window.Whisper.events.trigger('leaveGroup', this);
      },
      onDeleteMessages: this.deleteMessages,
      onInviteContacts: () => {
        window.Whisper.events.trigger('inviteContacts', this);
      },
      onClearNickname: () => {
        void this.setLokiProfile({ displayName: null });
      },
    };

    return result;
  }

  public async updateGroupAdmins(groupAdmins: Array<string>) {
    const existingAdmins = _.sortBy(this.getGroupAdmins());
    const newAdmins = _.sortBy(groupAdmins);

    if (_.isEqual(existingAdmins, newAdmins)) {
      window.log.info(
        'Skipping updates of groupAdmins/moderators. No change detected.'
      );
      return;
    }
    this.set({ groupAdmins });
    await this.commit();
  }

  public async onReadMessage(message: any, readAt: any) {
    // We mark as read everything older than this message - to clean up old stuff
    //   still marked unread in the database. If the user generally doesn't read in
    //   the desktop app, so the desktop app only gets read syncs, we can very
    //   easily end up with messages never marked as read (our previous early read
    //   sync handling, read syncs never sent because app was offline)

    // We queue it because we often get a whole lot of read syncs at once, and
    //   their markRead calls could very easily overlap given the async pull from DB.

    // Lastly, we don't send read syncs for any message marked read due to a read
    //   sync. That's a notification explosion we don't need.
    return this.queueJob(() =>
      this.markRead(message.get('received_at'), {
        sendReadReceipts: false,
        readAt,
      })
    );
  }

  public async getUnread() {
    return window.Signal.Data.getUnreadByConversation(this.id, {
      MessageCollection: MessageCollection,
    });
  }

  public async getUnreadCount() {
    return window.Signal.Data.getUnreadCountByConversation(this.id);
  }

  public validate(attributes: any) {
    const required = ['id', 'type'];
    const missing = _.filter(required, attr => !attributes[attr]);
    if (missing.length) {
      return `Conversation must have ${missing}`;
    }

    if (attributes.type !== 'private' && attributes.type !== 'group') {
      return `Invalid conversation type: ${attributes.type}`;
    }

    const error = this.validateNumber();
    if (error) {
      return error;
    }

    return null;
  }

  public validateNumber() {
    if (!this.id) {
      return 'Invalid ID';
    }
    if (!this.isPrivate()) {
      return null;
    }

    // Check if it's hex
    const isHex = this.id.replace(/[\s]*/g, '').match(/^[0-9a-fA-F]+$/);
    if (!isHex) {
      return 'Invalid Hex ID';
    }

    // Check if the pubkey length is 33 and leading with 05 or of length 32
    const len = this.id.length;
    if ((len !== 33 * 2 || !/^05/.test(this.id)) && len !== 32 * 2) {
      return 'Invalid Pubkey Format';
    }

    this.set({ id: this.id });
    return null;
  }

  public queueJob(callback: any) {
    // tslint:disable-next-line: no-promise-as-boolean
    const previous = this.pending || Promise.resolve();

    const taskWithTimeout = window.textsecure.createTaskWithTimeout(
      callback,
      `conversation ${this.idForLogging()}`
    );

    this.pending = previous.then(taskWithTimeout, taskWithTimeout);
    const current = this.pending;

    current.then(() => {
      if (this.pending === current) {
        delete this.pending;
      }
    });

    return current;
  }
  public getRecipients() {
    if (this.isPrivate()) {
      return [this.id];
    }
    const me = UserUtils.getOurPubKeyStrFromCache();
    return _.without(this.get('members'), me);
  }

  public async getQuoteAttachment(attachments: any, preview: any) {
    const {
      loadAttachmentData,
      getAbsoluteAttachmentPath,
    } = window.Signal.Migrations;

    if (attachments && attachments.length) {
      return Promise.all(
        attachments
          .filter(
            (attachment: any) =>
              attachment &&
              attachment.contentType &&
              !attachment.pending &&
              !attachment.error
          )
          .slice(0, 1)
          .map(async (attachment: any) => {
            const { fileName, thumbnail, contentType } = attachment;

            return {
              contentType,
              // Our protos library complains about this field being undefined, so we
              //   force it to null
              fileName: fileName || null,
              thumbnail: thumbnail
                ? {
                    ...(await loadAttachmentData(thumbnail)),
                    objectUrl: getAbsoluteAttachmentPath(thumbnail.path),
                  }
                : null,
            };
          })
      );
    }

    if (preview && preview.length) {
      return Promise.all(
        preview
          .filter((item: any) => item && item.image)
          .slice(0, 1)
          .map(async (attachment: any) => {
            const { image } = attachment;
            const { contentType } = image;

            return {
              contentType,
              // Our protos library complains about this field being undefined, so we
              //   force it to null
              fileName: null,
              thumbnail: image
                ? {
                    ...(await loadAttachmentData(image)),
                    objectUrl: getAbsoluteAttachmentPath(image.path),
                  }
                : null,
            };
          })
      );
    }

    return [];
  }

  public async makeQuote(quotedMessage: any) {
    const { getName } = window.Signal.Types.Contact;
    const contact = quotedMessage.getContact();
    const attachments = quotedMessage.get('attachments');
    const preview = quotedMessage.get('preview');

    const body = quotedMessage.get('body');
    const embeddedContact = quotedMessage.get('contact');
    const embeddedContactName =
      embeddedContact && embeddedContact.length > 0
        ? getName(embeddedContact[0])
        : '';

    return {
      author: contact.id,
      id: quotedMessage.get('sent_at'),
      text: body || embeddedContactName,
      attachments: await this.getQuoteAttachment(attachments, preview),
    };
  }

  public toOpenGroup() {
    if (!this.isPublic()) {
      throw new Error('tried to run toOpenGroup for not public group');
    }

    return new OpenGroup({
      server: this.get('server'),
      channel: this.get('channelId'),
      conversationId: this.id,
    });
  }
  public async sendMessageJob(message: MessageModel) {
    try {
      const uploads = await message.uploadData();
      const { id } = message;
      const expireTimer = this.get('expireTimer');
      const destination = this.id;
      const now = Date.now();

      const chatMessage = new ChatMessage({
        body: uploads.body,
        identifier: id,
        timestamp: message.get('sent_at') || now,
        attachments: uploads.attachments,
        expireTimer,
        preview: uploads.preview,
        quote: uploads.quote,
        lokiProfile: this.getOurProfile(),
      });

      if (this.isPublic()) {
        const openGroup = this.toOpenGroup();

        const openGroupParams = {
          body: uploads.body,
          timestamp: message.get('sent_at') || now,
          group: openGroup,
          attachments: uploads.attachments,
          preview: uploads.preview,
          quote: uploads.quote,
          identifier: id,
        };
        const openGroupMessage = new OpenGroupMessage(openGroupParams);
        // we need the return await so that errors are caught in the catch {}
        await getMessageQueue().sendToGroup(openGroupMessage);
        return;
      }

      const destinationPubkey = new PubKey(destination);
      if (this.isPrivate()) {
        // Handle Group Invitation Message
        if (message.get('groupInvitation')) {
          const groupInvitation = message.get('groupInvitation');
          const groupInvitMessage = new GroupInvitationMessage({
            identifier: id,
            timestamp: message.get('sent_at') || now,
            serverName: groupInvitation.name,
            channelId: groupInvitation.channelId,
            serverAddress: groupInvitation.address,
            expireTimer: this.get('expireTimer'),
          });
          // we need the return await so that errors are caught in the catch {}
          await getMessageQueue().sendToPubKey(
            destinationPubkey,
            groupInvitMessage
          );
          return;
        }
        // we need the return await so that errors are caught in the catch {}
        await getMessageQueue().sendToPubKey(destinationPubkey, chatMessage);
        return;
      }

      if (this.isMediumGroup()) {
        const closedGroupChatMessage = new ClosedGroupChatMessage({
          chatMessage,
          groupId: destination,
        });

        // we need the return await so that errors are caught in the catch {}
        await getMessageQueue().sendToGroup(closedGroupChatMessage);
        return;
      }

      if (this.isClosedGroup()) {
        throw new Error(
          'Legacy group are not supported anymore. You need to recreate this group.'
        );
      }

      throw new TypeError(`Invalid conversation type: '${this.get('type')}'`);
    } catch (e) {
      await message.saveErrors(e);
      return null;
    }
  }
  public async sendMessage(
    body: string,
    attachments: any,
    quote: any,
    preview: any,
    groupInvitation = null
  ) {
    this.clearTypingTimers();

    const destination = this.id;
    const expireTimer = this.get('expireTimer');
    const recipients = this.getRecipients();

    const now = Date.now();

    window.log.info(
      'Sending message to conversation',
      this.idForLogging(),
      'with timestamp',
      now
    );
    // be sure an empty quote is marked as undefined rather than being empty
    // otherwise upgradeMessageSchema() will return an object with an empty array
    // and this.get('quote') will be true, even if there is no quote.
    const editedQuote = _.isEmpty(quote) ? undefined : quote;
    const { upgradeMessageSchema } = window.Signal.Migrations;

    const messageWithSchema = await upgradeMessageSchema({
      type: 'outgoing',
      body,
      conversationId: destination,
      quote: editedQuote,
      preview,
      attachments,
      sent_at: now,
      received_at: now,
      expireTimer,
      recipients,
    });

    if (this.isPublic()) {
      // Public chats require this data to detect duplicates
      messageWithSchema.source = UserUtils.getOurPubKeyStrFromCache();
      messageWithSchema.sourceDevice = 1;
    } else {
      messageWithSchema.destination = destination;
    }

    const attributes: OutgoingMessageCreationAttributes = {
      ...messageWithSchema,
      groupInvitation,
      id: window.getGuid(),
      conversationId: this.id,
    };

    const model = this.addSingleMessage(attributes);
    MessageController.getInstance().register(model.id, model);

    const id = await model.commit();
    model.set({ id });

    if (this.isPrivate()) {
      model.set({ destination });
    }
    if (this.isPublic()) {
      await model.setServerTimestamp(new Date().getTime());
    }

    window.Whisper.events.trigger('messageAdded', {
      conversationKey: this.id,
      messageModel: model,
    });

    this.set({
      lastMessage: model.getNotificationText(),
      lastMessageStatus: 'sending',
      active_at: now,
    });
    await this.commit();

    // We're offline!
    if (!window.textsecure.messaging) {
      const error = new Error('Network is not available');
      error.name = 'SendMessageNetworkError';
      (error as any).number = this.id;
      await model.saveErrors([error]);
      return null;
    }

    this.queueJob(async () => {
      await this.sendMessageJob(model);
    });
    return null;
  }

  public async updateAvatarOnPublicChat({ url, profileKey }: any) {
    if (!this.isPublic()) {
      return;
    }
    if (!this.get('profileSharing')) {
      return;
    }

    if (profileKey && typeof profileKey !== 'string') {
      // eslint-disable-next-line no-param-reassign
      // tslint:disable-next-line: no-parameter-reassignment
      profileKey = window.Signal.Crypto.arrayBufferToBase64(profileKey);
    }
    const serverAPI = await window.lokiPublicChatAPI.findOrCreateServer(
      this.get('server')
    );
    if (!serverAPI) {
      return;
    }
    await serverAPI.setAvatar(url, profileKey);
  }
  public async bouncyUpdateLastMessage() {
    if (!this.id) {
      return;
    }
    if (!this.get('active_at')) {
      window.log.info('Skipping update last message as active_at is falsy');
      return;
    }
    const messages = await window.Signal.Data.getMessagesByConversation(
      this.id,
      { limit: 1, MessageCollection: MessageCollection }
    );
    const lastMessageModel = messages.at(0);
    const lastMessageJSON = lastMessageModel ? lastMessageModel.toJSON() : null;
    const lastMessageStatusModel = lastMessageModel
      ? lastMessageModel.getMessagePropStatus()
      : null;
    const lastMessageUpdate = window.Signal.Types.Conversation.createLastMessageUpdate(
      {
        currentTimestamp: this.get('active_at') || null,
        lastMessage: lastMessageJSON,
        lastMessageStatus: lastMessageStatusModel,
        lastMessageNotificationText: lastMessageModel
          ? lastMessageModel.getNotificationText()
          : null,
      }
    );
    // Because we're no longer using Backbone-integrated saves, we need to manually
    //   clear the changed fields here so our hasChanged() check below is useful.
    (this as any).changed = {};
    this.set(lastMessageUpdate);
    if (this.hasChanged()) {
      await this.commit();
    }
  }

  public async updateExpirationTimer(
    providedExpireTimer: any,
    providedSource?: string,
    receivedAt?: number,
    options: any = {}
  ) {
    let expireTimer = providedExpireTimer;
    let source = providedSource;

    _.defaults(options, { fromSync: false, fromGroupUpdate: false });

    if (!expireTimer) {
      expireTimer = null;
    }
    if (
      this.get('expireTimer') === expireTimer ||
      (!expireTimer && !this.get('expireTimer'))
    ) {
      return null;
    }

    window.log.info("Update conversation 'expireTimer'", {
      id: this.idForLogging(),
      expireTimer,
      source,
    });

    source = source || UserUtils.getOurPubKeyStrFromCache();

    // When we add a disappearing messages notification to the conversation, we want it
    //   to be above the message that initiated that change, hence the subtraction.
    const timestamp = (receivedAt || Date.now()) - 1;

    this.set({ expireTimer });
    await this.commit();

    let message: MessageModel;
    const sharedArgs = {
      // Even though this isn't reflected to the user, we want to place the last seen
      //   indicator above it. We set it to 'unread' to trigger that placement.
      unread: true,
      conversationId: this.id,
      // No type; 'incoming' messages are specially treated by conversation.markRead()
      sent_at: timestamp,
      received_at: timestamp,
      flags: SignalService.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      expirationTimerUpdate: {
        expireTimer,
        source,
        fromSync: options.fromSync,
        fromGroupUpdate: options.fromGroupUpdate,
      },
      expireTimer: 0,
      type: 'incoming' as MessageModelType,
      source,
    }

    if(UserUtils.isUsFromCache(source)) {
      message = new MessageModel(initOutgoingMessage(sharedArgs));
    } else {
      message = new MessageModel(initIncomingMessage(sharedArgs));

    }

    message.set({ destination: this.id });

    if (message.isOutgoing()) {
      message.set({ recipients: this.getRecipients() });
    }

    const id = await message.commit();

    message.set({ id });
    window.Whisper.events.trigger('messageAdded', {
      conversationKey: this.id,
      messageModel: message,
    });

    await this.commit();

    // if change was made remotely, don't send it to the number/group
    if (receivedAt) {
      return message;
    }

    let profileKey;
    if (this.get('profileSharing')) {
      profileKey = window.storage.get('profileKey');
    }

    const expireUpdate = {
      identifier: id,
      timestamp,
      expireTimer,
      profileKey,
    };

    if (!expireUpdate.expireTimer) {
      delete expireUpdate.expireTimer;
    }

    if (this.isMe()) {
      const expirationTimerMessage = new ExpirationTimerUpdateMessage(
        expireUpdate
      );
      return message.sendSyncMessageOnly(expirationTimerMessage);
    }

    if (this.get('type') === 'private') {
      const expirationTimerMessage = new ExpirationTimerUpdateMessage(
        expireUpdate
      );
      const pubkey = new PubKey(this.get('id'));
      await getMessageQueue().sendToPubKey(pubkey, expirationTimerMessage);
    } else {
      const expireUpdateForGroup = {
        ...expireUpdate,
        groupId: this.get('id'),
      };

      const expirationTimerMessage = new ExpirationTimerUpdateMessage(
        expireUpdateForGroup
      );
      // special case when we are the only member of a closed group
      const ourNumber = UserUtils.getOurPubKeyStrFromCache();

      if (
        this.get('members').length === 1 &&
        this.get('members')[0] === ourNumber
      ) {
        return message.sendSyncMessageOnly(expirationTimerMessage);
      }
      await getMessageQueue().sendToGroup(expirationTimerMessage);
    }
    return message;
  }

  public isSearchable() {
    return !this.get('left');
  }

  public async commit() {
    await window.Signal.Data.updateConversation(this.id, this.attributes, {
      Conversation: ConversationModel,
    });
    this.trigger('change', this);
  }

  public async addMessage(attrs: OutgoingMessageCreationAttributes | IncomingMessageCreationAttributes) {
    const isIncoming = attrs.type === 'incoming';
    const args = isIncoming ? initIncomingMessage(attrs) : initOutgoingMessage(attrs);
    const model = new MessageModel(args);

    const messageId = await model.commit();
    model.set({ id: messageId });
    window.Whisper.events.trigger('messageAdded', {
      conversationKey: this.id,
      messageModel: model,
    });
    return model;
  }

  public async leaveGroup() {
    if (this.get('type') !== ConversationType.GROUP) {
      window.log.error('Cannot leave a non-group conversation');
      return;
    }

    if (this.isMediumGroup()) {
      await leaveClosedGroup(this.id);
    } else {
      throw new Error(
        'Legacy group are not supported anymore. You need to create this group again.'
      );
    }
  }

  public async markRead(newestUnreadDate: any, providedOptions: any = {}) {
    const options = providedOptions || {};
    _.defaults(options, { sendReadReceipts: true });

    const conversationId = this.id;
    window.Whisper.Notifications.remove(
      window.Whisper.Notifications.where({
        conversationId,
      })
    );
    let unreadMessages = await this.getUnread();

    const oldUnread = unreadMessages.filter(
      (message: any) => message.get('received_at') <= newestUnreadDate
    );

    let read = await Promise.all(
      _.map(oldUnread, async providedM => {
        const m = MessageController.getInstance().register(
          providedM.id,
          providedM
        );

        await m.markRead(options.readAt);
        const errors = m.get('errors');
        return {
          sender: m.get('source'),
          timestamp: m.get('sent_at'),
          hasErrors: Boolean(errors && errors.length),
        };
      })
    );

    // Some messages we're marking read are local notifications with no sender
    read = _.filter(read, m => Boolean(m.sender));
    const realUnreadCount = await this.getUnreadCount();
    if (read.length === 0) {
      const cachedUnreadCountOnConvo = this.get('unreadCount');
      if (cachedUnreadCountOnConvo !== read.length) {
        // reset the unreadCount on the convo to the real one coming from markRead messages on the db
        this.set({ unreadCount: 0 });
        await this.commit();
      } else {
        // window.log.info('markRead(): nothing newly read.');
      }
      return;
    }
    unreadMessages = unreadMessages.filter((m: any) => Boolean(m.isIncoming()));

    this.set({ unreadCount: realUnreadCount });

    const mentionRead = (() => {
      const stillUnread = unreadMessages.filter(
        (m: any) => m.get('received_at') > newestUnreadDate
      );
      const ourNumber = UserUtils.getOurPubKeyStrFromCache();
      return !stillUnread.some(
        (m: any) =>
          m.propsForMessage &&
          m.propsForMessage.text &&
          m.propsForMessage.text.indexOf(`@${ourNumber}`) !== -1
      );
    })();

    if (mentionRead) {
      this.set({ mentionedUs: false });
    }

    await this.commit();

    // If a message has errors, we don't want to send anything out about it.
    //   read syncs - let's wait for a client that really understands the message
    //      to mark it read. we'll mark our local error read locally, though.
    //   read receipts - here we can run into infinite loops, where each time the
    //      conversation is viewed, another error message shows up for the contact
    read = read.filter(item => !item.hasErrors);

    if (this.isPublic()) {
      window.log.debug('public conversation... No need to send read receipt');
      return;
    }

    if (this.isPrivate() && read.length && options.sendReadReceipts) {
      window.log.info(`Sending ${read.length} read receipts`);
      if (window.storage.get('read-receipt-setting')) {
        await Promise.all(
          _.map(_.groupBy(read, 'sender'), async (receipts, sender) => {
            const timestamps = _.map(receipts, 'timestamp').filter(
              t => !!t
            ) as Array<number>;
            const receiptMessage = new ReadReceiptMessage({
              timestamp: Date.now(),
              timestamps,
            });

            const device = new PubKey(sender);
            await getMessageQueue().sendToPubKey(device, receiptMessage);
          })
        );
      }
    }
  }

  // LOKI PROFILES
  public async setNickname(nickname: string) {
    const trimmed = nickname && nickname.trim();
    if (this.get('nickname') === trimmed) {
      return;
    }

    this.set({ nickname: trimmed });
    await this.commit();

    await this.updateProfileName();
  }
  public async setLokiProfile(newProfile: any) {
    if (!_.isEqual(this.get('profile'), newProfile)) {
      this.set({ profile: newProfile });
      await this.commit();
    }

    // a user cannot remove an avatar. Only change it
    // if you change this behavior, double check all setLokiProfile calls (especially the one in EditProfileDialog)
    if (newProfile.avatar) {
      await this.setProfileAvatar({ path: newProfile.avatar });
    }

    await this.updateProfileName();
  }
  public async updateProfileName() {
    // Prioritise nickname over the profile display name
    const nickname = this.getNickname();
    const profile = this.getLokiProfile();
    const displayName = profile && profile.displayName;

    const profileName = nickname || displayName || null;
    await this.setProfileName(profileName);
  }
  public getLokiProfile() {
    return this.get('profile');
  }
  public getNickname() {
    return this.get('nickname');
  }
  // maybe "Backend" instead of "Source"?
  public async setPublicSource(newServer: any, newChannelId: any) {
    if (!this.isPublic()) {
      window.log.warn(
        `trying to setPublicSource on non public chat conversation ${this.id}`
      );
      return;
    }
    if (
      this.get('server') !== newServer ||
      this.get('channelId') !== newChannelId
    ) {
      // mark active so it's not in the contacts list but in the conversation list
      this.set({
        server: newServer,
        channelId: newChannelId,
        active_at: Date.now(),
      });
      await this.commit();
    }
  }
  public getPublicSource() {
    if (!this.isPublic()) {
      window.log.warn(
        `trying to getPublicSource on non public chat conversation ${this.id}`
      );
      return null;
    }
    return {
      server: this.get('server'),
      channelId: this.get('channelId'),
      conversationId: this.get('id'),
    };
  }
  public async getPublicSendData() {
    const channelAPI = await window.lokiPublicChatAPI.findOrCreateChannel(
      this.get('server'),
      this.get('channelId'),
      this.id
    );
    return channelAPI;
  }
  public getLastRetrievedMessage() {
    if (!this.isPublic()) {
      return null;
    }
    const lastMessageId = this.get('lastPublicMessage') || 0;
    return lastMessageId;
  }
  public async setLastRetrievedMessage(newLastMessageId: any) {
    if (!this.isPublic()) {
      return;
    }
    if (this.get('lastPublicMessage') !== newLastMessageId) {
      this.set({ lastPublicMessage: newLastMessageId });
      await this.commit();
    }
  }
  public isAdmin(pubKey?: string) {
    if (!this.isPublic()) {
      return false;
    }
    if (!pubKey) {
      throw new Error('isAdmin() pubKey is falsy');
    }
    const groupAdmins = this.getGroupAdmins();
    return Array.isArray(groupAdmins) && groupAdmins.includes(pubKey);
  }
  // SIGNAL PROFILES
  public async getProfiles() {
    // request all conversation members' keys
    let ids = [];
    if (this.isPrivate()) {
      ids = [this.id];
    } else {
      ids = this.get('members');
    }
    return Promise.all(_.map(ids, this.getProfile));
  }

  // This function is wrongly named by signal
  // This is basically an `update` function and thus we have overwritten it with such
  public async getProfile(id: string) {
    const c = await ConversationController.getInstance().getOrCreateAndWait(
      id,
      'private'
    );

    // We only need to update the profile as they are all stored inside the conversation
    await c.updateProfileName();
  }
  public async setProfileName(name: string) {
    const profileName = this.get('profileName');
    if (profileName !== name) {
      this.set({ profileName: name });
      await this.commit();
    }
  }
  public async setGroupName(name: string) {
    const profileName = this.get('name');
    if (profileName !== name) {
      this.set({ name });
      await this.commit();
    }
  }
  public async setSubscriberCount(count: number) {
    this.set({ subscriberCount: count });
    // Not sure if we care about updating the database
  }
  public async setGroupNameAndAvatar(name: any, avatarPath: any) {
    const currentName = this.get('name');
    const profileAvatar = this.get('profileAvatar');
    if (profileAvatar !== avatarPath || currentName !== name) {
      // only update changed items
      if (profileAvatar !== avatarPath) {
        this.set({ profileAvatar: avatarPath });
      }
      if (currentName !== name) {
        this.set({ name });
      }
      // save
      await this.commit();
    }
  }
  public async setProfileAvatar(avatar: any) {
    const profileAvatar = this.get('profileAvatar');
    if (profileAvatar !== avatar) {
      this.set({ profileAvatar: avatar });
      await this.commit();
    }
  }
  public async setProfileKey(profileKey: any) {
    // profileKey is a string so we can compare it directly
    if (this.get('profileKey') !== profileKey) {
      this.set({
        profileKey,
        accessKey: null,
      });

      await this.deriveAccessKeyIfNeeded();

      await this.commit();
    }
  }

  public async deriveAccessKeyIfNeeded() {
    const profileKey = this.get('profileKey');
    if (!profileKey) {
      return;
    }
    if (this.get('accessKey')) {
      return;
    }

    try {
      const profileKeyBuffer = window.Signal.Crypto.base64ToArrayBuffer(
        profileKey
      );
      const accessKeyBuffer = await window.Signal.Crypto.deriveAccessKey(
        profileKeyBuffer
      );
      const accessKey = window.Signal.Crypto.arrayBufferToBase64(
        accessKeyBuffer
      );
      this.set({ accessKey });
    } catch (e) {
      window.log.warn(`Failed to derive access key for ${this.id}`);
    }
  }

  public async upgradeMessages(messages: any) {
    // tslint:disable-next-line: one-variable-per-declaration
    for (let max = messages.length, i = 0; i < max; i += 1) {
      const message = messages.at(i);
      const { attributes } = message;
      const { schemaVersion } = attributes;

      if (
        schemaVersion < window.Signal.Types.Message.VERSION_NEEDED_FOR_DISPLAY
      ) {
        // Yep, we really do want to wait for each of these
        // eslint-disable-next-line no-await-in-loop
        const { upgradeMessageSchema } = window.Signal.Migrations;

        const upgradedMessage = await upgradeMessageSchema(attributes);
        message.set(upgradedMessage);
        // eslint-disable-next-line no-await-in-loop
        await upgradedMessage.commit();
      }
    }
  }

  public hasMember(pubkey: string) {
    return _.includes(this.get('members'), pubkey);
  }
  // returns true if this is a closed/medium or open group
  public isGroup() {
    return this.get('type') === 'group';
  }

  public copyPublicKey() {
    window.clipboard.writeText(this.id);

    ToastUtils.pushCopiedToClipBoard();
  }

  public changeNickname() {
    window.Whisper.events.trigger('showNicknameDialog', {
      pubKey: this.id,
      nickname: this.getNickname(),
      onOk: (newName: string) => this.setNickname(newName),
    });
  }

  public deleteContact() {
    let title = window.i18n('delete');
    let message = window.i18n('deleteContactConfirmation');

    if (this.isGroup()) {
      title = window.i18n('leaveGroup');
      message = window.i18n('leaveGroupConfirmation');
    }

    window.confirmationDialog({
      title,
      message,
      resolve: () => {
        void ConversationController.getInstance().deleteContact(this.id);
      },
    });
  }

  public async deletePublicMessages(messages: Array<MessageModel>) {
    const channelAPI = await this.getPublicSendData();

    if (!channelAPI) {
      throw new Error('Unable to get public channel API');
    }

    const invalidMessages = messages.filter(m => !m.attributes.serverId);
    const pendingMessages = messages.filter(m => m.attributes.serverId);

    let deletedServerIds = [];
    let ignoredServerIds = [];

    if (pendingMessages.length > 0) {
      const result = await channelAPI.deleteMessages(
        pendingMessages.map(m => m.attributes.serverId)
      );
      deletedServerIds = result.deletedIds;
      ignoredServerIds = result.ignoredIds;
    }

    const toDeleteLocallyServerIds = _.union(
      deletedServerIds,
      ignoredServerIds
    );
    let toDeleteLocally = messages.filter(m =>
      toDeleteLocallyServerIds.includes(m.attributes.serverId)
    );
    toDeleteLocally = _.union(toDeleteLocally, invalidMessages);

    await Promise.all(
      toDeleteLocally.map(async m => {
        await this.removeMessage(m.id);
      })
    );

    return toDeleteLocally;
  }

  public async removeMessage(messageId: any) {
    await Data.removeMessage(messageId, {
      Message: MessageModel,
    });
    window.Whisper.events.trigger('messageDeleted', {
      conversationKey: this.id,
      messageId,
    });
  }

  public deleteMessages() {
    let params;
    if (this.isPublic()) {
      throw new Error(
        'Called deleteMessages() on an open group. Only leave group is supported.'
      );
    } else {
      params = {
        title: window.i18n('deleteMessages'),
        message: window.i18n('deleteConversationConfirmation'),
        resolve: () => this.destroyMessages(),
      };
    }

    window.confirmationDialog(params);
  }

  public async destroyMessages() {
    await window.Signal.Data.removeAllMessagesInConversation(this.id, {
      MessageCollection,
    });

    window.Whisper.events.trigger('conversationReset', {
      conversationKey: this.id,
    });
    // destroy message keeps the active timestamp set so the
    // conversation still appears on the conversation list but is empty
    this.set({
      lastMessage: null,
      unreadCount: 0,
      mentionedUs: false,
    });

    await this.commit();
  }

  public getName() {
    if (this.isPrivate()) {
      return this.get('name');
    }
    return this.get('name') || window.i18n('unknown');
  }

  public getTitle() {
    if (this.isPrivate()) {
      const profileName = this.getProfileName();
      const number = this.getNumber();
      const name = profileName
        ? `${profileName} (${PubKey.shorten(number)})`
        : number;

      return this.get('name') || name;
    }
    return this.get('name') || 'Unknown group';
  }

  /**
   * For a private convo, returns the loki profilename if set, or a shortened
   * version of the contact pubkey.
   * Throws an error if called on a group convo.
   *
   */
  public getContactProfileNameOrShortenedPubKey() {
    if (!this.isPrivate()) {
      throw new Error(
        'getContactProfileNameOrShortenedPubKey() cannot be called with a non private convo.'
      );
    }

    const profileName = this.get('profileName');
    const pubkey = this.id;
    if (UserUtils.isUsFromCache(pubkey)) {
      return window.i18n('you');
    }
    return profileName || PubKey.shorten(pubkey);
  }

  /**
   * For a private convo, returns the loki profilename if set, or a full length
   * version of the contact pubkey.
   * Throws an error if called on a group convo.
   */
  public getContactProfileNameOrFullPubKey() {
    if (!this.isPrivate()) {
      throw new Error(
        'getContactProfileNameOrFullPubKey() cannot be called with a non private convo.'
      );
    }
    const profileName = this.get('profileName');
    const pubkey = this.id;
    if (UserUtils.isUsFromCache(pubkey)) {
      return window.i18n('you');
    }
    return profileName || pubkey;
  }

  public getProfileName() {
    if (this.isPrivate() && !this.get('name')) {
      return this.get('profileName');
    }
    return null;
  }

  /**
   * Returns
   *   displayName: string;
   *   avatarPointer: string;
   *   profileKey: Uint8Array;
   */
  public getOurProfile(): OurLokiProfile | undefined {
    try {
      // Secondary devices have their profile stored
      // in their primary device's conversation
      const ourNumber = window.storage.get('primaryDevicePubKey');
      const ourConversation = ConversationController.getInstance().get(
        ourNumber
      );
      let profileKey = null;
      if (this.get('profileSharing')) {
        profileKey = new Uint8Array(window.storage.get('profileKey'));
      }
      const avatarPointer = ourConversation.get('avatarPointer');
      const { displayName } = ourConversation.getLokiProfile();
      return { displayName, avatarPointer, profileKey };
    } catch (e) {
      window.log.error(`Failed to get our profile: ${e}`);
      return undefined;
    }
  }

  public getNumber() {
    if (!this.isPrivate()) {
      return '';
    }
    return this.id;
  }

  public isPrivate() {
    return this.get('type') === 'private';
  }

  public getAvatarPath() {
    const avatar = this.get('avatar') || this.get('profileAvatar');
    if (typeof avatar === 'string') {
      return avatar;
    }

    if (avatar && avatar.path && typeof avatar.path === 'string') {
      const { getAbsoluteAttachmentPath } = window.Signal.Migrations;

      return getAbsoluteAttachmentPath(avatar.path) as string;
    }

    return null;
  }
  public getAvatar() {
    const url = this.getAvatarPath();

    return { url: url || null };
  }

  public async getNotificationIcon() {
    return new Promise(resolve => {
      const avatar = this.getAvatar();
      if (avatar.url) {
        resolve(avatar.url);
      } else {
        resolve(new window.Whisper.IdenticonSVGView(avatar).getDataUrl());
      }
    });
  }

  public async notify(message: any) {
    if (!message.isIncoming()) {
      return Promise.resolve();
    }
    const conversationId = this.id;

    return ConversationController.getInstance()
      .getOrCreateAndWait(message.get('source'), 'private')
      .then(sender =>
        sender.getNotificationIcon().then((iconUrl: any) => {
          const messageJSON = message.toJSON();
          const messageSentAt = messageJSON.sent_at;
          const messageId = message.id;
          const isExpiringMessage = this.isExpiringMessage(messageJSON);

          // window.log.info('Add notification', {
          //   conversationId: this.idForLogging(),
          //   isExpiringMessage,
          //   messageSentAt,
          // });
          window.Whisper.Notifications.add({
            conversationId,
            iconUrl,
            isExpiringMessage,
            message: message.getNotificationText(),
            messageId,
            messageSentAt,
            title: sender.getTitle(),
          });
        })
      );
  }
  public async notifyTyping({ isTyping, sender }: any) {
    // We don't do anything with typing messages from our other devices
    if (UserUtils.isUsFromCache(sender)) {
      return;
    }

    // typing only works for private chats for now
    if (!this.isPrivate()) {
      return;
    }

    const wasTyping = !!this.typingTimer;
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }

    // Note: We trigger two events because:
    //   'change' causes a re-render of this conversation's list item in the left pane

    if (isTyping) {
      this.typingTimer = global.setTimeout(
        this.clearContactTypingTimer.bind(this, sender),
        15 * 1000
      );

      if (!wasTyping) {
        // User was not previously typing before. State change!
        await this.commit();
      }
    } else {
      // tslint:disable-next-line: no-dynamic-delete
      this.typingTimer = null;
      if (wasTyping) {
        // User was previously typing, and is no longer. State change!
        await this.commit();
      }
    }
  }

  public async clearContactTypingTimer(sender: string) {
    if (!!this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;

      // User was previously typing, but timed out or we received message. State change!
      await this.commit();
    }
  }

  private isExpiringMessage(json: any) {
    if (json.type === 'incoming') {
      return false;
    }

    const { expireTimer } = json;

    return typeof expireTimer === 'number' && expireTimer > 0;
  }
}

export class ConversationCollection extends Backbone.Collection<
  ConversationModel
> {
  constructor(models?: Array<ConversationModel>) {
    super(models);
    this.comparator = (m: ConversationModel) => {
      return -m.get('active_at');
    };
  }
}
ConversationCollection.prototype.model = ConversationModel;
