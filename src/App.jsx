import React, { useState } from 'react';
import VolModel from './screens/VolModel';
import QuoteModel from './screens/QuoteModel';
import Risk from './screens/Risk';
import PnL from './screens/PnL';
import TestSimulation from './screens/TestSimulation';

const screens = [
  { id: 'vol-model', name: 'Vol Model', component: VolModel },
  { id: 'quote-model', name: 'Quote Model', component: QuoteModel },
  { id: 'risk', name: 'Risk', component: Risk },
  { id: 'pnl', name: 'P&L', component: PnL },
  { id: 'test', name: 'Test/Sim', component: TestSimulation },
];

export default function App() {
  const [activeScreen, setActiveScreen] = useState('vol-model');

  const ActiveComponent = screens.find(s => s.id === activeScreen)?.component;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <h1 className="text-xl font-bold text-gray-900">
                  Deribit BTC Options Pricer
                </h1>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                {screens.map((screen) => (
                  <button
                    key={screen.id}
                    onClick={() => setActiveScreen(screen.id)}
                    className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
                      activeScreen === screen.id
                        ? 'border-blue-500 text-gray-900'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {screen.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Active Screen */}
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {ActiveComponent && <ActiveComponent />}
      </main>
    </div>
  );
}