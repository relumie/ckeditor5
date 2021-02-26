/**
 * @license Copyright (c) 2003-2021, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module clipboard/dragdrop
 */

/* globals setTimeout, clearTimeout */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import LiveRange from '@ckeditor/ckeditor5-engine/src/model/liverange';
import MouseObserver from '@ckeditor/ckeditor5-engine/src/view/observer/mouseobserver';
import Widget from '@ckeditor/ckeditor5-widget/src/widget';
import uid from '@ckeditor/ckeditor5-utils/src/uid';
import env from '@ckeditor/ckeditor5-utils/src/env';
import { isWidget } from '@ckeditor/ckeditor5-widget/src/utils';

import ClipboardPipeline from './clipboardpipeline';
import ClipboardObserver from './clipboardobserver';

import { throttle } from 'lodash-es';

import '../theme/clipboard.css';

/**
 * The drag and drop feature. It works on top of {@link module:clipboard/clipboardpipeline~ClipboardPipeline}.
 *
 * Read more about the clipboard integration in {@glink framework/guides/deep-dive/clipboard "Clipboard" deep dive} guide.
 *
 * @extends module:core/plugin~Plugin
 */
export default class DragDrop extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'DragDrop';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ ClipboardPipeline, Widget ];
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;
		const view = editor.editing.view;

		/**
		 * The LiveRange over the original content that is being dragged.
		 *
		 * @private
		 * @type {module:engine/model/liverange~LiveRange}
		 */
		this._draggedRange = null;

		/**
		 * The UID of current dragging that is used to verify if the drop started in the same editor as dragstart.
		 *
		 * **Note**: This is a workaround for broken 'dragend' events (they are not fired if the source text node got removed).
		 *
		 * @private
		 * @type {String}
		 */
		this._draggingUid = '';

		/**
		 * The reference to the view element that currently has a 'draggable' attribute set (it's set while dragging).
		 *
		 * @private
		 * @type {module:engine/view/element~Element}
		 */
		this._draggableElement = null;

		/**
		 * A throttled callback updating drop marker.
		 *
		 * @private
		 * @type {Function}
		 */
		this._updateDropMarkerThrottled = throttle( targetRange => this._updateDropMarker( targetRange ), 40 );

		/**
		 * A delayed callback removing drop marker.
		 *
		 * @private
		 * @type {Function}
		 */
		this._removeDropMarkerDelayed = delay( () => this._removeDropMarker(), 40 );

		view.addObserver( ClipboardObserver );
		view.addObserver( MouseObserver );

		this._setupDragging();
		this._setupContentInsertionIntegration();
		this._setupClipboardInputIntegration();
		this._setupDropMarker();
		this._setupDraggableAttributeHandling();

		this.on( 'change:isEnabled', ( evt, data, isEnabled ) => {
			if ( !isEnabled ) {
				this._finalizeDragging( false );
			}
		} );
	}

	/**
	 * @inheritDoc
	 */
	destroy() {
		if ( this._draggedRange ) {
			this._draggedRange.detach();
			this._draggedRange = null;
		}

		this._updateDropMarkerThrottled.cancel();
		this._removeDropMarkerDelayed.cancel();

		return super.destroy();
	}

	/**
	 * Drag & drop events handling.
	 *
	 * @private
	 */
	_setupDragging() {
		const editor = this.editor;
		const modelDocument = editor.model.document;
		const view = editor.editing.view;
		const viewDocument = view.document;

		// The handler for the drag start, it's responsible for setting data transfer object.
		this.listenTo( viewDocument, 'dragstart', ( evt, data ) => {
			if ( !this.isEnabled ) {
				return;
			}

			const selection = modelDocument.selection;
			const domConverter = editor.editing.view.domConverter;

			// Don't start dragging if nothing is selected.
			if ( selection.isCollapsed ) {
				data.preventDefault();

				return;
			}

			// Don't drag the editable element itself.
			if ( data.domTarget.nodeType == 1 && domConverter.mapDomToView( data.domTarget ).is( 'rootElement' ) ) {
				data.preventDefault();

				return;
			}

			// TODO we could clone this node somewhere and style it to match editing view but without handles,
			//  selection outline, WTA buttons, etc.
			// data.dataTransfer._native.setDragImage( data.domTarget, 0, 0 );

			// Store original selection range for later removing moved content.
			this._draggedRange = LiveRange.fromRange( modelDocument.selection.getFirstRange() );
			this._draggingUid = uid();

			data.dataTransfer.effectAllowed = 'copyMove';
			data.dataTransfer.setData( 'application/ckeditor5-dragging-uid', this._draggingUid );

			const content = editor.data.toView( editor.model.getSelectedContent( modelDocument.selection ) );

			viewDocument.fire( 'clipboardOutput', { dataTransfer: data.dataTransfer, content, method: evt.name } );
		}, { priority: 'low' } );

		// The handler for finalizing drag & drop. It should be triggered always after dragging completed
		// even if it was completed in a different application.
		// Note: This is not fired if source text node got removed while downcasting a marker.
		this.listenTo( viewDocument, 'dragend', ( evt, data ) => {
			if ( !this.isEnabled ) {
				return;
			}

			this._finalizeDragging( !data.dataTransfer.isCanceled && data.dataTransfer.dropEffect == 'move' );
		}, { priority: 'low' } );

		// Dragging over the editable.
		this.listenTo( viewDocument, 'dragenter', () => {
			if ( !this.isEnabled ) {
				return;
			}

			view.focus();
		} );

		// Dragging out of the editable.
		this.listenTo( viewDocument, 'dragleave', () => {
			if ( !this.isEnabled ) {
				return;
			}

			// We don't know if the mouse left the editor or just some element in it so lets wait a few milliseconds
			// to check if 'dragover' is not fired.
			this._removeDropMarkerDelayed();
		} );

		// Handler for moving dragged content over the target area.
		this.listenTo( viewDocument, 'dragging', ( evt, data ) => {
			if ( !this.isEnabled ) {
				return;
			}

			this._removeDropMarkerDelayed.cancel();

			if ( editor.isReadOnly ) {
				data.dataTransfer.dropEffect = 'none';

				return;
			}

			const targetRange = findDropTargetRange( editor, data.targetRanges, data.target );

			// This is content being dragged from other editor or content.
			// Moving out of current editor instance is not possible until 'dragend' event case will be fixed.
			if ( !this._draggedRange ) {
				data.dataTransfer.dropEffect = 'copy';
			}

			if ( targetRange ) {
				this._updateDropMarkerThrottled( targetRange );
			}
		}, { priority: 'low' } );
	}

	/**
	 * Integration with the `clipboardInput` event.
	 *
	 * @private
	 */
	_setupClipboardInputIntegration() {
		const editor = this.editor;
		const view = editor.editing.view;
		const viewDocument = view.document;

		// Update the event targetRanges and abort dropping if dropping over itself.
		this.listenTo( viewDocument, 'clipboardInput', ( evt, data ) => {
			if ( !this.isEnabled || data.method != 'drop' ) {
				return;
			}

			const targetRange = findDropTargetRange( editor, data.targetRanges, data.target );

			// The dragging markers must be removed after searching for the target range because sometimes
			// the target lands on the marker itself.
			this._removeDropMarker();

			if ( !targetRange ) {
				this._finalizeDragging( false );
				evt.stop();

				return;
			}

			// Since we can't rely on the dragend event, we must check if the local dragRange is from the current drag & drop
			// or it's from some previous not cleared one.
			if ( this._draggedRange && this._draggingUid != data.dataTransfer.getData( 'application/ckeditor5-dragging-uid' ) ) {
				this._draggedRange.detach();
				this._draggedRange = null;
				this._draggingUid = '';
			}

			// Don't do anything if some content was dragged within the same document to the same position.
			const isMove = getFinalDropEffect( data.dataTransfer ) == 'move';

			if ( isMove && this._draggedRange && this._draggedRange.containsRange( targetRange, true ) ) {
				this._finalizeDragging( false );
				evt.stop();

				return;
			}

			// Override the target ranges with the one adjusted to the best one for a drop.
			data.targetRanges = [ editor.editing.mapper.toViewRange( targetRange ) ];
		}, { priority: 'high' } );
	}

	/**
	 * Integration with the `ClipboardPipeline` `contentInsertion` event.
	 *
	 * @private
	 */
	_setupContentInsertionIntegration() {
		const clipboardPipeline = this.editor.plugins.get( ClipboardPipeline );

		clipboardPipeline.on( 'contentInsertion', ( evt, data ) => {
			if ( !this.isEnabled || data.method !== 'drop' ) {
				return;
			}

			// Update the selection to the target range in the same change block to avoid selection post-fixing
			// and to be able to clone text attributes for plain text dropping.
			const ranges = data.targetRanges.map( viewRange => this.editor.editing.mapper.toModelRange( viewRange ) );

			this.editor.model.change( writer => writer.setSelection( ranges ) );
		}, { priority: 'high' } );

		clipboardPipeline.on( 'contentInsertion', ( evt, data ) => {
			if ( !this.isEnabled || data.method !== 'drop' ) {
				return;
			}

			// Remove dragged range content, remove markers, clean after dragging.
			const isMove = getFinalDropEffect( data.dataTransfer ) == 'move';

			// Whether any content was inserted (insertion might fail if the schema is disallowing some elements
			// (for example an image caption allows only content of block but not blocks themself.
			// Some integrations might not return valid range (i.e., table pasting).
			const isSuccess = !data.resultRange || !data.resultRange.isCollapsed;

			this._finalizeDragging( isSuccess && isMove );
		}, { priority: 'lowest' } );
	}

	/**
	 * Adds listeners that adds 'draggable' attribute to the elements while the mouse button is down so the dragging could start.
	 *
	 * @private
	 */
	_setupDraggableAttributeHandling() {
		const editor = this.editor;
		const view = editor.editing.view;
		const viewDocument = view.document;

		// Add 'draggable' attribute to the widget while pressing the selection handle.
		// This is required for widgets to be draggable. In Chrome it will enable dragging text nodes.
		this.listenTo( viewDocument, 'mousedown', ( evt, data ) => {
			// The lack of data can be caused by editor tests firing fake mouse events. This should not occur
			// in real-life scenarios but this greatly simplifies editor tests that would otherwise fail a lot.
			if ( !this.isEnabled || !data ) {
				return;
			}

			// TODO: Let's have a isWidgetSelectionHandleDomElement() helper in ckeditor5-widget utils.
			if ( data.target.hasClass( 'ck-widget__selection-handle' ) ) {
				this._draggableElement = data.target.findAncestor( isWidget );
			}

			// Set attribute 'draggable' on editable to allow immediate dragging of the selected text range.
			else if ( env.isBlink && !viewDocument.selection.isCollapsed && !editor.model.document.selection.getSelectedElement() ) {
				this._draggableElement = viewDocument.selection.editableElement;
			}

			// Check if there is a widget to drag if mouse down wasn't directly on the editable element.
			else if ( !data.target.is( 'editableElement' ) ) {
				// Find closest ancestor that is either a widget or an editable element...
				const ancestor = data.target.findAncestor( node => isWidget( node ) || node.is( 'editableElement' ) );

				// ...and if closer was the widget then enable dragging it.
				if ( isWidget( ancestor ) ) {
					this._draggableElement = ancestor;
				}
			}

			if ( this._draggableElement ) {
				view.change( writer => {
					writer.setAttribute( 'draggable', 'true', this._draggableElement );
					writer.setAttribute( 'spellcheck', 'false', this._draggableElement.root );
				} );
			}
		} );

		// Remove the draggable attribute in case no dragging started (only mousedown + mouseup).
		this.listenTo( viewDocument, 'mouseup', () => {
			this._clearDraggableAttributes();
		} );
	}

	/**
	 * Removes 'draggable' attribute from the element that was used for dragging.
	 *
	 * @private
	 */
	_clearDraggableAttributes() {
		if ( !this._draggableElement ) {
			return;
		}

		// Remove 'draggable' and 'spellcheck' attributes.
		this.editor.editing.view.change( writer => {
			writer.removeAttribute( 'draggable', this._draggableElement );
			writer.removeAttribute( 'spellcheck', this._draggableElement.root );
		} );

		this._draggableElement = null;
	}

	/**
	 * Creates downcast conversion for the drop target marker.
	 *
	 * @private
	 */
	_setupDropMarker() {
		const editor = this.editor;

		// Drop marker conversion for hovering over widgets.
		editor.conversion.for( 'editingDowncast' ).markerToHighlight( {
			model: 'drop-target',
			view: {
				classes: [ 'ck-clipboard-drop-target-range' ]
			}
		} );

		// Drop marker conversion for in text drop target.
		editor.conversion.for( 'editingDowncast' ).markerToElement( {
			model: 'drop-target',
			view: ( data, { writer } ) => {
				const inText = editor.model.schema.checkChild( data.markerRange.start, '$text' );

				if ( !inText ) {
					return;
				}

				return writer.createUIElement( 'span', { class: 'ck ck-clipboard-drop-target-position' }, function( domDocument ) {
					const domElement = this.toDomElement( domDocument );

					// Using zero width no-break space to make this marker as high as text and also making text not break on marker.
					domElement.innerHTML = '&#65279;<span></span>&#65279;';

					return domElement;
				} );
			}
		} );
	}

	/**
	 * Updates the drop target marker to the provided range.
	 *
	 * @private
	 * @param {module:engine/model/range~Range} targetRange The range to set marker to.
	 */
	_updateDropMarker( targetRange ) {
		const editor = this.editor;
		const markers = editor.model.markers;

		editor.model.change( writer => {
			if ( markers.has( 'drop-target' ) ) {
				if ( !markers.get( 'drop-target' ).getRange().isEqual( targetRange ) ) {
					writer.updateMarker( 'drop-target', { range: targetRange } );
				}
			} else {
				writer.addMarker( 'drop-target', {
					range: targetRange,
					usingOperation: false,
					affectsData: false
				} );
			}
		} );
	}

	/**
	 * Remove the drop target marker.
	 *
	 * @private
	 */
	_removeDropMarker() {
		const model = this.editor.model;

		this._removeDropMarkerDelayed.cancel();
		this._updateDropMarkerThrottled.cancel();

		if ( model.markers.has( 'drop-target' ) ) {
			model.change( writer => {
				writer.removeMarker( 'drop-target' );
			} );
		}
	}

	/**
	 * Deletes the dragged content from it's original range and clears dragging state.
	 *
	 * @private
	 * @param {Boolean} moved Whether the move succeeded.
	 */
	_finalizeDragging( moved ) {
		const editor = this.editor;
		const model = editor.model;

		this._removeDropMarker();
		this._clearDraggableAttributes();

		this._draggingUid = '';

		if ( !this._draggedRange ) {
			return;
		}

		// Delete moved content.
		if ( moved ) {
			model.change( () => {
				// TODO: The commented out code will be useful when dropping between blocks will be supported.

				// const startPosition = LivePosition.fromPosition( this._draggedRange.start, 'toPrevious' );
				// const endPosition = LivePosition.fromPosition( this._draggedRange.end, 'toNext' );

				model.deleteContent( model.createSelection( this._draggedRange ), { doNotAutoparagraph: true } );

				// // Remove the parent blocks if all content of the block was moved.
				// const startParent = startPosition.parent;
				// const endParent = endPosition.parent;
				//
				// startPosition.detach();
				// endPosition.detach();
				//
				// if ( startParent.isEmpty ) {
				// 	writer.remove( startParent );
				// }
				//
				// if ( endParent.isEmpty && startParent != endParent ) {
				// 	model.remove( endParent );
				// }
			} );
		}

		this._draggedRange.detach();
		this._draggedRange = null;
	}
}

// Returns fixed selection range for given position and target element.
//
// @param {module:core/editor/editor~Editor} editor
// @param {Array.<module:engine/view/range~Range>} targetViewRanges
// @param {module:engine/view/element~Element} targetViewElement
// @returns {module:engine/model/range~Range|null}
export function findDropTargetRange( editor, targetViewRanges, targetViewElement ) {
	const model = editor.model;
	const mapper = editor.editing.mapper;

	let range = null;

	const targetViewPosition = targetViewRanges ? targetViewRanges[ 0 ].start : null;

	// An UIElement is not a valid drop element, use parent (this could be a drop marker or any other UIElement.
	if ( targetViewElement.is( 'uiElement' ) ) {
		targetViewElement = targetViewElement.parent;
	}

	// Quick win if the target is a widget (but not a nested editable).
	range = findDropTargetRangeOnWidget( editor, targetViewElement );

	if ( range ) {
		return range;
	}

	// The easiest part is over, now we need to move to the model space.

	// Find target model element and position.
	const targetModelElement = getClosestMappedModelElement( editor, targetViewElement );
	const targetModelPosition = targetViewPosition ? mapper.toModelPosition( targetViewPosition ) : null;

	// There is no target position while hovering over an empty table cell.
	// In Safari target position can be empty while hovering over a widget (for example, a page-break).
	// Find the drop position inside the element.
	if ( !targetModelPosition ) {
		return findDropTargetRangeInElement( editor, targetModelElement );
	}

	// Check if target position is between blocks and adjust drop position to the next object.
	// This is because while hovering over a root element next to a widget the target position can jump in crazy places.
	range = findDropTargetRangeBetweenBlocks( editor, targetModelPosition, targetModelElement );

	if ( range ) {
		return range;
	}

	// Try fixing selection position.
	// In Firefox the target position lands before widgets but in other browsers it tend to land after a widget.
	range = model.schema.getNearestSelectionRange( targetModelPosition, env.isGecko ? 'forward' : 'backward' );

	if ( range ) {
		return range;
	}

	// There is no valid selection position inside the current limit element so find closest object ancestor.
	// This happens if the model position lands directly in the <table> element itself (view target element was a `<td>`
	// so a nested editable, but view target position was directly in the `<figure>` element).
	return findDropTargetRangeOnAncestorObject( editor, targetModelPosition.parent );
}

// Returns fixed selection range for given position and target element if it is over the widget but not over it's nested editable.
//
// @param {module:core/editor/editor~Editor} editor
// @param {module:engine/view/element~Element} targetViewElement
// @returns {module:engine/model/range~Range|null}
function findDropTargetRangeOnWidget( editor, targetViewElement ) {
	const model = editor.model;
	const mapper = editor.editing.mapper;

	// Quick win if the target is a widget.
	if ( isWidget( targetViewElement ) ) {
		return model.createRangeOn( mapper.toModelElement( targetViewElement ) );
	}

	// Check if we are deeper over a widget (but not over nested editable).
	if ( !targetViewElement.is( 'editableElement' ) ) {
		// Find closest ancestor that is either a widget or an editable element...
		const ancestor = targetViewElement.findAncestor( node => isWidget( node ) || node.is( 'editableElement' ) );

		// ...and if closer was the widget then it's a drop target.
		if ( isWidget( ancestor ) ) {
			return model.createRangeOn( mapper.toModelElement( ancestor ) );
		}
	}

	return null;
}

// Returns fixed selection range inside a model element.
//
// @param {module:core/editor/editor~Editor} editor
// @param {module:engine/model/element~Element} targetModelElement
// @returns {module:engine/model/range~Range}
function findDropTargetRangeInElement( editor, targetModelElement ) {
	const model = editor.model;
	const schema = model.schema;

	const positionAtElementStart = model.createPositionAt( targetModelElement, 0 );

	return schema.getNearestSelectionRange( positionAtElementStart, 'forward' );
}

// Returns fixed selection range for given position and target element if the drop would be between blocks.
//
// @param {module:core/editor/editor~Editor} editor
// @param {module:engine/model/position~Position} targetModelPosition
// @param {module:engine/model/element~Element} targetModelElement
// @returns {module:engine/model/range~Range|null}
function findDropTargetRangeBetweenBlocks( editor, targetModelPosition, targetModelElement ) {
	const model = editor.model;

	// Check if target is between blocks.
	if ( !model.schema.checkChild( targetModelElement, '$block' ) ) {
		return null;
	}

	// Find position between blocks.
	const positionAtElementStart = model.createPositionAt( targetModelElement, 0 );

	// Get the common part of the path (inside the target element and the target position).
	const commonPath = targetModelPosition.path.slice( 0, positionAtElementStart.path.length );

	// Position between the blocks.
	const betweenBlocksPosition = model.createPositionFromPath( targetModelPosition.root, commonPath );
	const nodeAfter = betweenBlocksPosition.nodeAfter;

	// Adjust drop position to the next object.
	// This is because while hovering over a root element next to a widget the target position can jump in crazy places.
	if ( nodeAfter && model.schema.isObject( nodeAfter ) ) {
		return model.createRangeOn( nodeAfter );
	}

	return null;
}

// Returns a selection range on the ancestor object.
//
// @param {module:core/editor/editor~Editor} editor
// @param {module:engine/model/element~Element} element
// @returns {module:engine/model/range~Range|null}
function findDropTargetRangeOnAncestorObject( editor, element ) {
	const model = editor.model;

	while ( element ) {
		if ( model.schema.isObject( element ) ) {
			return model.createRangeOn( element );
		}

		element = element.parent;
	}

	return null;
}

// Returns the closest model element for the specified view element.
//
// @param {module:core/editor/editor~Editor} editor
// @param {module:engine/view/element~Element} element
// @returns {module:engine/model/element~Element}
function getClosestMappedModelElement( editor, element ) {
	const mapper = editor.editing.mapper;
	const view = editor.editing.view;

	const targetModelElement = mapper.toModelElement( element );

	if ( targetModelElement ) {
		return targetModelElement;
	}

	// Find mapped ancestor if the target is inside not mapped element (for example inline code element).
	const viewPosition = view.createPositionBefore( element );
	const viewElement = mapper.findMappedViewAncestor( viewPosition );

	return mapper.toModelElement( viewElement );
}

// Returns the drop effect that should be a result of dragging content.
// This function is handling a quirk when checking the effect in the 'drop' DOM event.
function getFinalDropEffect( dataTransfer ) {
	if ( env.isGecko ) {
		return dataTransfer.dropEffect;
	}

	return dataTransfer.effectAllowed == 'copyMove' ? 'move' : 'copy';
}

// Returns a function wrapper that will trigger a function after a specified wait time.
// The timeout can be canceled by calling the cancel function on the returned wrapped function.
//
// @param {Function} func The function to wrap.
// @param {Number} wait The timeout in ms.
// @returns {Function}
function delay( func, wait ) {
	let timer;

	function delayed( ...args ) {
		delayed.cancel();
		timer = setTimeout( () => func( ...args ), wait );
	}

	delayed.cancel = () => {
		clearTimeout( timer );
	};

	return delayed;
}