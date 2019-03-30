import Resolver from './resolver';
import { Vue } from '../plugin';
import RuleContainer from './ruleContainer';
import { addEventListener, addEventListenerOnce } from '../utils/events';
import { findModel } from '../utils/vnode';
import { getValidator } from '../state';
import {
  uniqId,
  createFlags,
  normalizeRules,
  isNullOrUndefined,
  toggleClass,
  isTextInput,
  isCallable,
  toArray,
  isCheckboxOrRadioInput,
  isEqual,
  values,
  defineNonReactive,
  assign
} from '../utils';

const DEFAULT_CLASSES = {
  touched: 'touched', // the control has been blurred
  untouched: 'untouched', // the control hasn't been blurred
  valid: 'valid', // model is valid
  invalid: 'invalid', // model is invalid
  pristine: 'pristine', // control has not been interacted with
  dirty: 'dirty' // control has been interacted with
};

export default class Field {
  constructor (el, binding, vnode) {
    defineNonReactive(this, 'el', el);
    defineNonReactive(this, 'vid', vnode.data.ref || uniqId());
    defineNonReactive(this, 'deps', {});
    defineNonReactive(this, 'validator', getValidator());
    defineNonReactive(this, 'vmId', vnode.context._uid);
    defineNonReactive(this, 'ctx', vnode.context);
    defineNonReactive(this, 'opts', {});
    defineNonReactive(this, 'binding', binding);
    defineNonReactive(this, 'vnode', vnode);
    defineNonReactive(this, 'initialized', false);

    this.el._vid = this.vid;
    this._value = undefined;
    this.flags = Vue.observable(createFlags());
    this.errors = Vue.observable([]);
    this.name = Resolver.resolveName(el, vnode);
  }

  get value () {
    return this._value;
  }

  set value (value) {
    if (!isEqual(value, this._value)) {
      this.validateDeps();
    }

    this._value = value;
  }

  static from (el, vnode) {
    if (!vnode.context.$_veeObserver) {
      return null;
    }

    return vnode.context.$_veeObserver.refs[el._vid];
  }

  validate () {
    const options = Resolver.generate(this.el, this.binding, this.vnode);
    this.opts.aria = options.aria;
    this.opts.validity = options.validity;

    return this.validator.verify(this.value, this.rules, {
      name: options.alias || options.name,
      bails: options.bails,
      values: this.createValuesLookup(),
    }).then(res => {
      this.flags.validated = true;
      this.applyResult(res);

      return res;
    });
  }

  fieldDeps () {
    const rules = normalizeRules(this.rules);
    this.isRequired = !!rules.required;

    return Object.keys(rules).filter(RuleContainer.isTargetRule).map(rule => {
      return rules[rule][0];
    });
  }

  createValuesLookup () {
    return this.fieldDeps().reduce((acc, depName) => {
      const fields = this.ctx.$_veeObserver.refs;
      if (!fields[depName]) {
        return acc;
      }

      // register cross-field dependencies
      fields[depName].deps[this.vid] = this;
      acc[depName] = fields[depName].value;

      return acc;
    }, {});
  }

  onModelUpdated (model) {
    if (model.value === this.value) {
      return;
    }

    this.value = model.value;
    if (this.initialized) {
      this.validate();
    }
  }

  validateDeps () {
    values(this.deps).forEach(dep => {
      if (dep.flags.validated) {
        this.ctx.$nextTick(() => {
          dep.validate();
        });
      }
    });
  }

  applyResult ({ valid, errors }) {
    this.flags.valid = valid;
    this.flags.invalid = !valid;
    this.errors = errors;
    this.applyClasses();
    this.applyAriaAttrs();
    this.applyCustomValidity();
  }

  addLiteListeners (el) {
    addEventListener(el, 'input', () => {
      this._emittedEvt = true;
    });
  }

  addListeners (el) {
    if (this.hasListener) {
      return;
    }

    const inputEvt = this._determineInputEvent();
    const events = this._determineEventList(inputEvt);

    events.forEach(ev => {
      addEventListener(el, ev, (e) => {
        const value = e.target.value;
        this.value = value;
        this.validate();
        this._emittedEvt = false;
      });
    });
    this.hasListener = true;
  }

  onUpdate (el, binding, vnode) {
    this.el = el;
    this.binding = binding;
    this.vnode = vnode;
    const model = findModel(vnode);
    this.rules = binding.value;
    this.registerField(vnode);
    this.updateOptions(el, binding, vnode);
    if (model) {
      this.onModelUpdated(model);
      this.addLiteListeners(el);
    } else {
      this.addListeners(el);
    }

    this._emittedEvt = false;
    this.applyClasses();
    if (binding.modifiers && binding.modifiers.immediate && !this.flags.validated) {
      this.validate();
    }

    this.addActionListeners();
    this.initialized = true;
  }

  updateOptions (el, binding, vnode) {
    const options = Resolver.generate(el, binding, vnode);
    this.opts.events = options.events;
    this.opts.classes = options.classes;
    this.opts.classNames = assign({}, DEFAULT_CLASSES, options.classNames);
    this.opts.componentInstance = options.component;
  }

  registerField (vnode) {
    if (!vnode.context.$_veeObserver) {
      throw new Error('Did you forget to mapValidationState?');
    }

    vnode.context.$_veeObserver.subscribe(this);
  }

  /**
   * Keeps a reference of the most current validation run.
   */
  waitFor (pendingPromise) {
    this._waitingFor = pendingPromise;
  }

  isWaitingFor (promise) {
    return this._waitingFor === promise;
  }

  /**
   * Resets field flags and errors.
   */
  reset () {
    if (this._cancellationToken) {
      this._cancellationToken.cancelled = true;
      delete this._cancellationToken;
    }

    const defaults = createFlags();
    Object.keys(this.flags).filter(flag => flag !== 'required').forEach(flag => {
      this.flags[flag] = defaults[flag];
    });

    // update initial value
    this.initialValue = this.value;
    this.flags.changed = false;

    this.addActionListeners();
    this.updateClasses(true);
    this.updateAriaAttrs();
    this.updateCustomValidity();
  }

  /**
   * Sets the flags and their negated counterparts, and updates the classes and re-adds action listeners.
   */
  setFlags (flags) {
    const negated = {
      pristine: 'dirty',
      dirty: 'pristine',
      valid: 'invalid',
      invalid: 'valid',
      touched: 'untouched',
      untouched: 'touched'
    };

    Object.keys(flags).forEach(flag => {
      this.flags[flag] = flags[flag];
      // if it has a negation and was not specified, set it as well.
      if (negated[flag] && flags[negated[flag]] === undefined) {
        this.flags[negated[flag]] = !flags[flag];
      }
    });

    if (
      flags.untouched !== undefined ||
      flags.touched !== undefined ||
      flags.dirty !== undefined ||
      flags.pristine !== undefined
    ) {
      this.addActionListeners();
    }
    this.updateClasses();
    this.updateAriaAttrs();
    this.updateCustomValidity();
  }

  /**
   * Updates the element classes depending on each field flag status.
   */
  applyClasses (isReset = false) {
    if (!this.opts.classes || this.isDisabled) return;

    const applyClasses = (el) => {
      toggleClass(el, this.opts.classNames.dirty, this.flags.dirty);
      toggleClass(el, this.opts.classNames.pristine, this.flags.pristine);
      toggleClass(el, this.opts.classNames.touched, this.flags.touched);
      toggleClass(el, this.opts.classNames.untouched, this.flags.untouched);

      // remove valid/invalid classes on reset.
      if (isReset) {
        toggleClass(el, this.opts.classNames.valid, false);
        toggleClass(el, this.opts.classNames.invalid, false);
      }

      // make sure we don't set any classes if the state is undetermined.
      if (!isNullOrUndefined(this.flags.valid) && this.flags.validated) {
        toggleClass(el, this.opts.classNames.valid, this.flags.valid);
      }

      if (!isNullOrUndefined(this.flags.invalid) && this.flags.validated) {
        toggleClass(el, this.opts.classNames.invalid, this.flags.invalid);
      }
    };

    if (!isCheckboxOrRadioInput(this.el)) {
      applyClasses(this.el);
      return;
    }

    const els = document.querySelectorAll(`input[name="${this.el.name}"]`);
    toArray(els).forEach(applyClasses);
  }

  /**
   * Adds the listeners required for automatic classes and some flags.
   */
  addActionListeners () {
    // remove previous listeners.
    if (!this.el) return;

    const onBlur = () => {
      this.flags.touched = true;
      this.flags.untouched = false;
      if (this.opts.classes) {
        toggleClass(this.el, this.opts.classNames.touched, true);
        toggleClass(this.el, this.opts.classNames.untouched, false);
      }
    };

    const inputEvent = isTextInput(this.el) ? 'input' : 'change';
    const onInput = () => {
      this.flags.dirty = true;
      this.flags.pristine = false;
      if (this.opts.classes) {
        toggleClass(this.el, this.opts.classNames.pristine, false);
        toggleClass(this.el, this.opts.classNames.dirty, true);
      }
    };

    if (this.componentInstance && isCallable(this.componentInstance.$once)) {
      this.componentInstance.$once('input', onInput);
      this.componentInstance.$once('blur', onBlur);
      return;
    }

    addEventListenerOnce(this.el, inputEvent, onInput);
    // Checkboxes and radio buttons on Mac don't emit blur naturally, so we listen on click instead.
    const blurEvent = isCheckboxOrRadioInput(this.el) ? 'change' : 'blur';
    addEventListenerOnce(this.el, blurEvent, onBlur);
  }

  /**
   * Determines the suitable primary event to listen for.
   */
  _determineInputEvent () {
    // if its a custom component, use the customized model event or the input event.
    if (this.componentInstance) {
      return (this.componentInstance.$options.model && this.componentInstance.$options.model.event) || 'input';
    }

    if (this.model && this.model.lazy) {
      return 'change';
    }

    if (isTextInput(this.el)) {
      return 'input';
    }

    return 'change';
  }

  /**
   * Determines the list of events to listen to.
   */
  _determineEventList (defaultInputEvent) {
    // if no event is configured, or it is a component or a text input then respect the user choice.
    if (!this.events.length || this.componentInstance || isTextInput(this.el)) {
      return [...this.events].map(evt => {
        if (evt === 'input' && this.model && this.model.lazy) {
          return 'change';
        }

        return evt;
      });
    }

    // force suitable event for non-text type fields.
    return this.events.map(e => {
      if (e === 'input') {
        return defaultInputEvent;
      }

      return e;
    });
  }

  /**
   * Updates aria attributes on the element.
   */
  applyAriaAttrs () {
    if (!this.opts.aria || !this.el || !isCallable(this.el.setAttribute)) return;

    this.el.setAttribute('aria-required', this.isRequired ? 'true' : 'false');
    this.el.setAttribute('aria-invalid', this.flags.invalid ? 'true' : 'false');
  }

  /**
   * Updates the custom validity for the field.
   */
  applyCustomValidity () {
    if (!this.opts.validity || !this.el || !isCallable(this.el.setCustomValidity)) return;

    this.el.setCustomValidity(this.errors[0] || '');
  }

  /**
   * Removes all listeners.
   */
  destroy () {
    // ignore the result of any ongoing validation.
    if (this._cancellationToken) {
      this._cancellationToken.cancelled = true;
    }
  }
}
